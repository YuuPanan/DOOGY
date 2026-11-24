import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { IdentityService } from '../src/identity';
import { AccountExportService } from '../src/account-export';
import { PrivacyService } from '../src/privacy';
import { RetentionService } from '../src/retention';
import { openBackendFixture } from './backend-fixture';
import { seedConfigurationContacts } from './configuration-contacts-fixture';

const password = 'Synthetic-configuration-contacts-2026';
const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
async function fixture() {
  process.env.DATA_MODE = 'offline';
  const backend = await openBackendFixture(() => new Date('2026-11-24T04:00:00.000Z')), db = backend.db, identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `configuration-contacts-${name}@example.invalid`, password });
  const owner = await register('owner'), member = await register('member'), viewer = await register('viewer'), outsider = await register('outsider');
  for (const [account, role] of [[member, 'caregiver'], [viewer, 'viewer']] as const) {
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: account.user.email, role });
    await identity.accept(account.user.id, invitation.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Configuration lifecycle pet' });
  const seeded = await seedConfigurationContacts(db, member.user.id, pet.id, owner.household.id);
  return { ...backend, db, identity, owner, member, viewer, outsider, pet, ...seeded, exporter: new AccountExportService(db), privacy: new PrivacyService(db), retention: new RetentionService(db) };
}

test('配置/联系人导出：当前家庭授权、完整版本JSON、主联系人及未验证同意元数据', async t => {
  const f = await fixture(); t.after(f.close);
  const scope = { household_id: f.owner.household.id };
  const history = (await f.exporter.page(f.viewer.user.id, 'pet_configuration_history', scope)).items;
  assert.equal(history.length, 2); assert.deepEqual(history.map((row: any) => row.version).sort(), [1, 2]);
  const edited = history.find((row: any) => row.version === 2);
  assert.equal(edited.before.buffer_m, 10); assert.equal(edited.after.buffer_m, 40); assert.deepEqual(edited.changed_fields, ['buffer_m']);
  const contact = (await f.exporter.page(f.viewer.user.id, 'household_contacts', scope)).items[0];
  assert.equal(contact.is_primary, true); assert.equal(contact.version, 2); assert.equal(contact.consent_status, 'reported_granted');
  assert.equal(contact.consent_source, 'household_member_reported'); assert.equal(contact.consent_verified, false);
  await assert.rejects(f.exporter.page(f.outsider.user.id, 'household_contacts', scope), status(404));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  await assert.rejects(f.exporter.page(f.viewer.user.id, 'pet_configuration_history', scope), status(404));
});

test('配置/联系人注销：匿名四个用户引用，保留共享配置和原始联系/同意元数据', async t => {
  const f = await fixture(); t.after(f.close);
  await f.privacy.closeAccount(f.member.user.id, { password, confirmation: 'DELETE' });
  const rows = await f.db.all('SELECT actor_kind,actor_user_id FROM pet_configuration_history WHERE pet_id=?', f.pet.id);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.actor_kind === 'user' && row.actor_user_id === null));
  const contact = (await f.db.get('SELECT * FROM household_contacts WHERE id=?', f.contact.id))!;
  for (const field of ['created_by','updated_by','consent_reported_by']) assert.equal(contact[field], null);
  assert.equal(contact.phone, '+86 13800000000'); assert.equal(contact.consent_status, 'reported_granted');
  assert.equal((await f.exporter.page(f.owner.user.id, 'pet_configuration_history', { household_id: f.owner.household.id })).items.length, 2);
});

test('配置/联系人保留与删除：独立保留计数，删宠不删家庭联系人，删家庭清联系人和缓存副本', async t => {
  const f = await fixture(); t.after(f.close);
  await f.retention.update(f.owner.user.id, f.owner.household.id, { password, enabled: true, activity_days: 1 });
  const preview = (await f.retention.preview(f.owner.user.id, f.owner.household.id)).households[0];
  assert.deepEqual(preview.retained_related_counts, { pet_configuration_history: 2, household_contacts: 1, contact_alerts: 0, contact_alert_recipients: 0 });
  await f.retention.execute(f.owner.user.id, f.owner.household.id, { password });
  assert.equal((await f.privacy.petPreview(f.owner.user.id, f.pet.id)).counts.pet_configuration_history, 2);
  await f.db.idempotent(f.owner.user.id, 'configuration-copy', 'copy', {}, () => ({ id: f.history[0].id, before: { private: true } }));
  await f.db.idempotent(f.owner.user.id, 'contact-copy', 'copy', {}, () => ({ id: f.contact.id, phone: f.contact.phone }));
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM pet_configuration_history'))!.n, 0);
  assert.ok(await f.db.get('SELECT id FROM household_contacts WHERE id=?', f.contact.id));
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE scope=?', 'configuration-copy'), undefined);
  await f.privacy.deleteHousehold(f.owner.user.id, f.owner.household.id, { password, confirmation: f.owner.household.id });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM household_contacts'))!.n, 0);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE scope=?', 'contact-copy'), undefined);
});
