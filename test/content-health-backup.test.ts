import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { PrivacyService } from '../src/privacy';
import { snapshotDatabase } from '../scripts/database-snapshot';
import { contentHealthTables, seedContentHealthData } from './content-health-fixture';

test('第二批真实SQLite备份恢复：目录版本/学习步骤/已阅逐字段保留，注销日志只清个人与宠物资料', async () => {
  process.env.DATA_MODE = 'offline';
  const prefix = resolve('data', `content-health-backup-${randomUUID()}`), files = ['source', 'snapshot', 'restored'].map(name => `${prefix}-${name}.db`);
  const db = new Db(files[0], () => new Date('2026-11-24T04:00:00.000Z'));
  let recovered: Db | undefined;
  try {
    const password = 'Synthetic-content-health-backup-2026', identity = new IdentityService(db), privacy = new PrivacyService(db);
    const owner = await identity.register({ email: 'content-health-backup@example.invalid', password });
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Second batch backup pet' });
    await seedContentHealthData(db, owner.user.id, pet.id);
    const before: Record<string, Row[]> = {};
    for (const table of contentHealthTables) before[table] = (await db.all(`SELECT * FROM ${table} ORDER BY rowid`)).map(row => ({ ...row }));
    assert.equal((await snapshotDatabase(files[0], files[1])).integrity, 'ok');
    await privacy.closeAccount(owner.user.id, { password, confirmation: 'DELETE' });
    const receipts = await privacy.receipts();
    await snapshotDatabase(files[1], files[2]);
    recovered = new Db(files[2], db.clock);
    for (const table of contentHealthTables) assert.deepEqual((await recovered.all(`SELECT * FROM ${table} ORDER BY rowid`)).map(row => ({ ...row })), before[table], table);
    await new PrivacyService(recovered).replay(receipts);
    for (const table of ['learning_progress','health_observation_reads']) assert.equal((await recovered.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n, 0);
    for (const table of ['content_items','content_versions']) assert.deepEqual((await recovered.all(`SELECT * FROM ${table} ORDER BY rowid`)).map(row => ({ ...row })), before[table], table);
    assert.equal((await recovered.get('SELECT closed_at FROM users WHERE id=?', owner.user.id))!.closed_at !== null, true);
    assert.equal((await new PrivacyService(recovered).replay(receipts)).applied, 0);
    assert.deepEqual(await recovered.all('PRAGMA foreign_key_check'), []);
  } finally {
    if (recovered) await recovered.close();
    await db.close();
    for (const file of files) for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(file + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
});
