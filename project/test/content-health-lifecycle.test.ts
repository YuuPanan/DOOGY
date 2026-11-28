import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { IdentityService } from '../src/identity';
import { AccountExportService } from '../src/account-export';
import { PrivacyService } from '../src/privacy';
import { RetentionService } from '../src/retention';
import { DevicesService, provisionDevice } from '../src/devices';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';
import { seedContentHealthData } from './content-health-fixture';

const password = 'Synthetic-content-health-lifecycle-2026';
async function fixture() {
  process.env.DATA_MODE = 'offline';
  let now = Date.parse('2026-11-01T04:00:00.000Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db, identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `content-lifecycle-${name}@example.invalid`, password });
  const owner = await register('owner'), member = await register('member');
  const invite = await identity.invite(owner.user.id, owner.household.id, { email: member.user.email, role: 'caregiver' });
  await identity.accept(member.user.id, invite.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Content lifecycle pet' });
  const seeded = await seedContentHealthData(db, member.user.id, pet.id);
  await db.run('INSERT INTO health_observation_reads VALUES (?,?,?)', owner.user.id, seeded.observation, db.now());
  return { ...backend, db, identity, owner, member, pet, ...seeded, exporter: new AccountExportService(db), privacy: new PrivacyService(db),
    retention: new RetentionService(db), advance: (days: number) => { now += days * 86400000; } };
}

test('第二批导出：学习按本人和内容版本分页，已阅按本人及当前家庭权限过滤', async t => {
  const f = await fixture(); t.after(f.close);
  const first = await f.exporter.page(f.member.user.id, 'learning_progress', { limit: 1 });
  const second = await f.exporter.page(f.member.user.id, 'learning_progress', { limit: 1, cursor: first.next_cursor });
  assert.equal(first.items.length, 1); assert.ok(first.next_cursor); assert.equal(second.next_cursor, null);
  assert.equal(first.items[0].learned, true); assert.deepEqual(first.items[0].completed_step_ids, ['step-one']);
  assert.equal(second.items[0].learned, false); assert.equal(second.items[0].learned_at, null);
  assert.equal((await f.exporter.page(f.owner.user.id, 'learning_progress', {})).items.length, 0);
  assert.equal((await f.exporter.page(f.member.user.id, 'health_observation_reads', {})).items[0].pet_id, f.pet.id);
  assert.equal((await f.exporter.page(f.owner.user.id, 'health_observation_reads', {})).items[0].user_id, f.owner.user.id);
  const manifest = await f.exporter.manifest(f.member.user.id);
  assert.ok(!manifest.personal_sections.includes('content_items')); assert.ok(!manifest.personal_sections.includes('content_versions'));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.member.user.id);
  assert.equal((await f.exporter.page(f.member.user.id, 'health_observation_reads', {})).items.length, 0);
  assert.equal((await f.exporter.page(f.member.user.id, 'learning_progress', {})).items.length, 2);
});

test('第二批删除：注销删除本人学习和已阅，宠物删除级联其他已阅，系统目录保留', async t => {
  const f = await fixture(); t.after(f.close);
  await f.db.idempotent(f.owner.user.id, 'second-batch-read-copy', 'read-copy', {}, () => ({ observation_id: f.observation }));
  await f.privacy.closeAccount(f.member.user.id, { password, confirmation: 'DELETE' });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM learning_progress WHERE user_id=?', f.member.user.id))!.n, 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM health_observation_reads WHERE user_id=?', f.member.user.id))!.n, 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM health_observation_reads'))!.n, 1);
  const preview = await f.privacy.petPreview(f.owner.user.id, f.pet.id);
  assert.equal(preview.related_counts.health_observation_reads, 1);
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM health_observation_reads'))!.n, 0);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE scope=?', 'second-batch-read-copy'), undefined);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM content_items'))!.n, 1);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM content_versions'))!.n, 2);
});

test('第二批保留：过期活动观察级联已阅并清理只含观察ID的回执，目录和学习不受影响', async t => {
  const f = await fixture(); t.after(f.close);
  const device = await provisionDevice(f.db, { serial_no: 'SECOND-BATCH-RETENTION' });
  const devices = new DevicesService(f.db); await devices.claim(f.owner.user.id, { ...device, pet_id: f.pet.id });
  const telemetry = new TelemetryService(f.db, devices, new NotificationService(f.db));
  await telemetry.ingest({ schema_version: '1.0', event_id: f.db.id(), device_id: device.device_id, boot_id: 'second-batch-retention', seq: 1,
    event_type: 'activity.reported', device_ts: f.db.now(), payload: { start_at: f.db.now(), end_at: new Date(Date.parse(f.db.now()) + 60000).toISOString(), steps: 10 } }, device.device_token);
  await telemetry.work();
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM activity_samples WHERE pet_id=?', f.pet.id))!.n, 1);
  await f.db.idempotent(f.owner.user.id, 'second-batch-retention-copy', 'read-copy', {}, () => ({ observation_id: f.observation }));
  f.advance(3);
  await f.retention.update(f.owner.user.id, f.owner.household.id, { password, enabled: true, activity_days: 1 });
  const preview = (await f.retention.preview(f.owner.user.id, f.owner.household.id)).households[0];
  assert.equal(preview.related_counts.health_observation_reads, 2);
  await f.retention.execute(f.owner.user.id, f.owner.household.id, { password });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM health_observation_reads'))!.n, 0);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE scope=?', 'second-batch-retention-copy'), undefined);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM learning_progress'))!.n, 2);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM content_items'))!.n, 1);
});
