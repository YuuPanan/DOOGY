import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { ContactsService } from '../src/contacts';
import { PrivacyService } from '../src/privacy';
import { snapshotDatabase } from '../scripts/database-snapshot';
import { configurationContactTables, seedConfigurationContacts } from './configuration-contacts-fixture';

test('配置/联系人真实SQLite恢复：两表逐字段保留，单联系人删除和共享作者注销日志均可重放', async () => {
  process.env.DATA_MODE = 'offline';
  const prefix = resolve('data', `configuration-contacts-backup-${randomUUID()}`), files = ['source', 'snapshot', 'restored'].map(name => `${prefix}-${name}.db`);
  const db = new Db(files[0], () => new Date('2026-11-24T04:00:00.000Z'));
  let recovered: Db | undefined;
  try {
    const password = 'Synthetic-configuration-contacts-backup-2026', identity = new IdentityService(db), privacy = new PrivacyService(db), contacts = new ContactsService(db);
    const owner = await identity.register({ email: 'configuration-backup-owner@example.invalid', password });
    const author = await identity.register({ email: 'configuration-backup-author@example.invalid', password });
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: author.user.email, role: 'caregiver' });
    await identity.accept(author.user.id, invitation.token);
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Configuration backup pet' });
    const seeded = await seedConfigurationContacts(db, author.user.id, pet.id, owner.household.id);
    const retained = await contacts.create(author.user.id, owner.household.id, { name: 'Retained synthetic contact', email: 'retained-synthetic@example.invalid', consent: { status: 'reported_granted' } });
    await db.idempotent(owner.user.id, 'configuration-backup-contact', 'old-contact', {}, () => ({ id: seeded.contact.id, phone: seeded.contact.phone }));
    const before: Record<string, Row[]> = {};
    for (const table of configurationContactTables) before[table] = (await db.all(`SELECT * FROM ${table} ORDER BY id`)).map(row => ({ ...row }));
    assert.equal((await snapshotDatabase(files[0], files[1])).integrity, 'ok');
    await contacts.delete(owner.user.id, seeded.contact.id, { expected_version: seeded.contact.version });
    const contactReceipts = await privacy.receipts(); assert.equal(contactReceipts.find(row => row.kind === 'household_contact' && row.resource_id === seeded.contact.id)?.kind, 'household_contact');
    await privacy.closeAccount(author.user.id, { password, confirmation: 'DELETE' });
    const receipts = await privacy.receipts();
    await snapshotDatabase(files[1], files[2]); recovered = new Db(files[2], db.clock);
    for (const table of configurationContactTables) assert.deepEqual((await recovered.all(`SELECT * FROM ${table} ORDER BY id`)).map(row => ({ ...row })), before[table], table);
    const replay = new PrivacyService(recovered); await replay.replay(contactReceipts);
    assert.equal(await recovered.get('SELECT id FROM household_contacts WHERE id=?', seeded.contact.id), undefined);
    assert.equal(await recovered.get('SELECT key FROM idempotency_keys WHERE key=?', 'old-contact'), undefined);
    await replay.replay(receipts);
    assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM pet_configuration_history WHERE pet_id=?', pet.id))!.n, 2);
    assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM pet_configuration_history WHERE actor_user_id IS NOT NULL'))!.n, 0);
    const contact = (await recovered.get('SELECT * FROM household_contacts WHERE id=?', retained.id))!;
    for (const field of ['created_by','updated_by','consent_reported_by']) assert.equal(contact[field], null);
    assert.equal(contact.email, 'retained-synthetic@example.invalid'); assert.equal(contact.consent_status, 'reported_granted');
    assert.equal((await recovered.get('SELECT closed_at FROM users WHERE id=?', author.user.id))!.closed_at !== null, true);
    assert.equal((await replay.replay(receipts)).applied, 0); assert.deepEqual(await recovered.all('PRAGMA foreign_key_check'), []);
  } finally {
    if (recovered) await recovered.close(); await db.close();
    for (const file of files) for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(file + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
});
