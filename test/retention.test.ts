import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db, Row } from '../src/db';
import { DevicesService, provisionDevice } from '../src/devices';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';
import { FencesService } from '../src/fences';
import { CareService } from '../src/care';
import { ReportingService } from '../src/reporting';
import { SharesService } from '../src/shares';
import { SupportService } from '../src/support';
import { RetentionService } from '../src/retention';

const password = 'Synthetic-retention-2026', day = 86400000;
const status = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
beforeEach(() => { process.env.DATA_MODE = 'offline'; });

async function fixture() {
  let time = Date.parse('2026-11-01T06:00:00Z'), seq = 0;
  const db = new Db(':memory:', () => new Date(time)), identity = new IdentityService(db), devices = new DevicesService(db);
  const register = (name: string) => identity.register({ email: `${name}@example.invalid`, password });
  const owner = await register('retention-owner'), viewer = await register('retention-viewer'), outsider = await register('retention-outsider');
  const invite = await identity.invite(owner.user.id, owner.household.id, { email: viewer.user.email, role: 'viewer' });
  await identity.accept(viewer.user.id, invite.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Retention synthetic pet' });
  const otherPet = await identity.createPet(outsider.user.id, { household_id: outsider.household.id, name: 'Unaffected synthetic pet' });
  const device = await provisionDevice(db, { serial_no: 'RETENTION-DEVICE' });
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  const telemetry = new TelemetryService(db, devices, new NotificationService(db)), retention = new RetentionService(db);
  const event = (event_type = 'location.reported', payload: Row = { lat: 31.23, lon: 121.47, accuracy_m: 5, source: 'gnss', signal: { private: 'retention-raw-private' } }) => ({
    schema_version: '1.0', event_id: `retention-event-${++seq}`, device_id: device.device_id, device_ts: db.now(), seq, boot_id: 'retention-boot', event_type, payload
  });
  const ingest = async (packet: Row) => { await telemetry.ingest(packet, device.device_token); await telemetry.work(); return packet; };
  return { db, identity, devices, owner, viewer, outsider, pet, otherPet, device, telemetry, retention, event, ingest,
    advance: (milliseconds: number) => { time += milliseconds; } };
}
async function snapshot(db: Db) {
  const result: Row = {};
  for (const row of await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) result[row.name] = await db.all(`SELECT * FROM ${row.name} ORDER BY rowid`);
  return JSON.stringify(result);
}
const enable = (f: Awaited<ReturnType<typeof fixture>>, values: Row = {}) => f.retention.update(f.owner.user.id, f.owner.household.id,
  { enabled: true, telemetry_days: 2, activity_days: 7, safety_days: 7, password, ...values });

test('保留策略默认关闭，只有所有者通过密码确认可启用，读取和错误请求不写数据', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const before = await snapshot(f.db);
  assert.equal((await f.retention.read(f.viewer.user.id, f.owner.household.id)).enabled, false);
  assert.equal((await f.retention.run(f.owner.household.id)).households[0].skipped, 'disabled');
  assert.equal(await snapshot(f.db), before);
  await assert.rejects(f.retention.read(f.outsider.user.id, f.owner.household.id), status(404));
  await assert.rejects(f.retention.update(f.viewer.user.id, f.owner.household.id, { enabled: true, password }), status(403));
  await assert.rejects(f.retention.preview(f.viewer.user.id, f.owner.household.id), status(403));
  await assert.rejects(enable(f, { password: 'wrong-password' }), status(401));
  await assert.rejects(enable(f, { telemetry_days: 0 }));
  assert.equal(await snapshot(f.db), before);
  await f.ingest(f.event()); f.advance(3 * day);
  await enable(f, { enabled: false });
  const disabled = await snapshot(f.db);
  assert.equal((await f.retention.preview(f.owner.user.id, f.owner.household.id)).households[0].counts.locations, 1);
  assert.equal((await f.retention.execute(f.owner.user.id, f.owner.household.id, { password })).households[0].skipped, 'disabled');
  assert.equal((await f.retention.run()).households.length, 0);
  assert.equal(await snapshot(f.db), disabled);
  const policy = await enable(f);
  assert.equal(policy.enabled, true); assert.equal(policy.telemetry_days, 2); assert.equal(policy.last_run_at, null);
  assert.ok(!JSON.stringify(await f.db.all('SELECT * FROM audit_logs')).includes(password));
});

test('保留预览零写入，执行同时清理原始点、快照、派生缓存并隔离其他家庭，事件身份保留', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const fence = await new FencesService(f.db).create(f.owner.user.id, { pet_id: f.pet.id, name: 'Retention fence', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
  const old = await f.ingest(f.event());
  const location = (await f.db.get('SELECT id FROM locations WHERE event_id=?', old.event_id))!;
  const activity = await f.ingest(f.event('activity.reported', { start_at: new Date(Date.parse(f.db.now()) - 3600000).toISOString(), end_at: f.db.now(), steps: 100, raw_metrics: { private: 'old-raw' } }));
  const oldSafety = await f.telemetry.emitSafety(f.pet.id, f.device.device_id, 'retention.old', f.db.now(), location.id, fence.id, { lat: 31.23, private: 'old-snapshot' });
  await f.db.run('INSERT INTO safety_acknowledgements VALUES (?,?,?,?)', oldSafety, f.owner.user.id, f.db.now(), 'old acknowledgement');
  await f.db.run('INSERT INTO daily_summaries VALUES (?,?,?,?,?,?,?)', f.pet.id, '2026-11-01', 'Asia/Shanghai', 'daily-v2', 1, f.db.now(), '{}');
  await f.db.run('INSERT INTO activity_observations VALUES (?,?,?,?,?,?,?,?)', f.db.id(), f.pet.id, '2026-11-01', 'Asia/Shanghai', 'rules-v1', 'old', f.db.now(), '{"steps":100}');
  await f.db.run('INSERT INTO behavior_feedback VALUES (?,?,?,?,?,?,?,?)', f.db.id(), f.pet.id, '2026-11-01', 'agree', 'retain user-authored comment', '{"steps":100}', f.owner.user.id, f.db.now());
  await new CareService(f.db).create(f.owner.user.id, { pet_id: f.pet.id, type: 'note', source: 'owner', recorded_at: f.db.now(), value: {}, notes: 'keep manual care' });
  f.advance(10 * day);
  const current = await f.ingest(f.event());
  const currentLocation = (await f.db.get('SELECT id FROM locations WHERE event_id=?', current.event_id))!;
  const copied = await f.telemetry.emitSafety(f.pet.id, f.device.device_id, 'retention.recent', f.db.now(), location.id, null, { lat: 31.23, private: 'copied-snapshot' });
  await f.db.run("UPDATE geofence_states SET last_location_id=?,last_ts=?,open_event_id=? WHERE fence_id=?", location.id, old.device_ts, oldSafety, fence.id);
  await f.db.run('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?)', f.owner.user.id, 'test', 'old', JSON.stringify({ pet_id: f.pet.id, private: 'copied-cache' }), '{"lat":31.23}', f.db.now());
  await f.db.run('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?)', f.viewer.user.id, 'test', 'former-member', '{}', JSON.stringify({ pet_id: f.pet.id, lat: 31.23 }), f.db.now());
  await f.db.run('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?)', f.outsider.user.id, 'test', 'other-household', '{}', JSON.stringify({ pet_id: f.otherPet.id }), f.db.now());
  await f.db.run('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?)', f.owner.user.id, 'test', 'same-user-other-household', '{}', JSON.stringify({ pet_id: f.otherPet.id }), f.db.now());
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  await f.db.audit(f.owner.user.id, 'test.retention.direct', old.event_id, { coordinates: [31.23, 121.47] });
  await f.db.audit(f.owner.user.id, 'test.retention.nested', 'unrelated-resource', { location: { id: location.id, lat: 31.23 } });
  await f.db.run('INSERT INTO daily_summaries VALUES (?,?,?,?,?,?,?)', f.otherPet.id, '2026-11-01', 'Asia/Shanghai', 'daily-v2', 0, f.db.now(), '{}');
  await enable(f);
  const before = await snapshot(f.db), preview = await f.retention.preview(f.owner.user.id, f.owner.household.id);
  assert.equal(await snapshot(f.db), before);
  assert.equal(preview.dry_run, true); assert.equal(preview.households[0].counts.locations, 1);
  assert.equal(preview.households[0].counts.activity_samples, 1);
  const actual = await f.retention.execute(f.owner.user.id, f.owner.household.id, { password });
  assert.deepEqual(actual.households[0].counts, preview.households[0].counts);
  assert.equal(await f.db.get('SELECT id FROM locations WHERE id=?', location.id), undefined);
  assert.ok(await f.db.get('SELECT id FROM locations WHERE id=?', currentLocation.id));
  assert.equal((await f.db.get('SELECT last_location_id FROM device_state WHERE device_id=?', f.device.device_id))!.last_location_id, currentLocation.id);
  assert.equal((await f.db.get('SELECT * FROM geofence_states WHERE fence_id=?', fence.id))!.last_location_id, null);
  const remaining = (await f.db.get('SELECT * FROM safety_events WHERE id=?', copied))!;
  assert.equal(remaining.location_id, null); assert.equal(remaining.details_json, '{}');
  assert.equal(await f.db.get('SELECT id FROM safety_events WHERE id=?', oldSafety), undefined);
  assert.equal((await f.db.get('SELECT COUNT(*) AS count FROM safety_acknowledgements'))!.count, 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS count FROM daily_summaries WHERE pet_id=?', f.pet.id))!.count, 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS count FROM daily_summaries WHERE pet_id=?', f.otherPet.id))!.count, 1);
  assert.equal((await f.db.get('SELECT COUNT(*) AS count FROM care_records WHERE pet_id=?', f.pet.id))!.count, 1);
  assert.equal((await f.db.get('SELECT evidence_json FROM behavior_feedback WHERE pet_id=?', f.pet.id))!.evidence_json, '{}');
  assert.deepEqual((await f.db.all('SELECT key FROM idempotency_keys ORDER BY key')).map(row => row.key), ['other-household','same-user-other-household']);
  assert.ok((await f.db.all("SELECT metadata_json FROM audit_logs WHERE action LIKE 'test.retention.%'")).every(row => row.metadata_json === '{}'));
  for (const packet of [old, activity]) {
    const event = (await f.db.get('SELECT * FROM device_events WHERE event_id=?', packet.event_id))!;
    assert.equal(event.envelope_json, '{}'); assert.equal(event.payload_json, '{}');
  }
  assert.notEqual((await f.db.get('SELECT envelope_json FROM device_events WHERE event_id=?', current.event_id))!.envelope_json, '{}');
});

test('保留原始内容窗口与结构化活动窗口独立，旧积压终止重试，设备信号和过期授权清理', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const sample = await f.ingest(f.event('activity.reported', { start_at: new Date(Date.parse(f.db.now()) - 3600000).toISOString(), end_at: f.db.now(), steps: 100, raw_metrics: { secret: 'raw' }, signal: { secret: 'signal' } }));
  await new ReportingService(f.db).lostMode(f.owner.user.id, f.device.device_id, { enabled: true });
  const share = await new SharesService(f.db).create(f.owner.user.id, f.pet.id, { consent: true });
  const ticket = await new SupportService(f.db).create(f.owner.user.id, { device_id: f.device.device_id, category: 'other', description: 'Synthetic retention ticket', diagnostics_consent: true });
  await f.db.run('UPDATE support_tickets SET diagnostics_expires_at=? WHERE id=?', f.db.now(), ticket.id);
  const pending = f.event(); await f.telemetry.ingest(pending, f.device.device_token);
  await f.db.run('UPDATE device_events SET next_attempt_at=? WHERE event_id=?', '2030-01-01T00:00:00.000Z', pending.event_id);
  f.advance(3 * day);
  await f.telemetry.ingest(f.event('state.reported', { battery_pct: 80 }), f.device.device_token);
  await f.telemetry.work();
  assert.equal((await f.db.get('SELECT reported_at FROM device_state WHERE device_id=?', f.device.device_id))!.reported_at, f.db.now());
  await enable(f);
  const result = await f.retention.execute(f.owner.user.id, f.owner.household.id, { password });
  assert.equal(result.households[0].counts.activity_samples, 0);
  const activity = (await f.db.get('SELECT * FROM activity_samples WHERE event_id=?', sample.event_id))!;
  assert.equal(activity.steps, 100); assert.equal(activity.raw_metrics_json, '{}');
  const expired = (await f.db.get('SELECT * FROM device_events WHERE event_id=?', pending.event_id))!;
  assert.equal(expired.process_status, 'dead'); assert.equal(expired.error, 'RETENTION_EXPIRED'); assert.equal(expired.envelope_json, '{}');
  assert.equal((await f.db.get('SELECT signal_json FROM device_state WHERE device_id=?', f.device.device_id))!.signal_json, null);
  assert.equal(await f.db.get('SELECT id FROM location_shares WHERE id=?', share.id), undefined);
  assert.equal((await f.db.get('SELECT diagnostics_json FROM support_tickets WHERE id=?', ticket.id))!.diagnostics_json, null);
  assert.equal(await f.telemetry.work(), 0);
  await assert.rejects(f.telemetry.ingest(pending, f.device.device_token), status(409));
  assert.equal((await f.db.get('SELECT COUNT(*) AS count FROM device_events WHERE event_id=?', pending.event_id))!.count, 1);
});

test('保留任务冷却按家庭持久化，强制预览和重复执行不产生新清理', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await enable(f);
  await f.retention.run();
  const first = (await f.retention.read(f.owner.user.id, f.owner.household.id)).last_run_at;
  assert.equal((await f.retention.run()).households[0].skipped, 'not_due');
  assert.ok(Object.values((await f.retention.preview(f.owner.user.id, f.owner.household.id)).households[0].counts).every(count => count === 0));
  assert.equal((await f.retention.read(f.owner.user.id, f.owner.household.id)).last_run_at, first);
  f.advance(3600000);
  assert.equal((await f.retention.run()).households[0].skipped, undefined);
  assert.notEqual((await f.retention.read(f.owner.user.id, f.owner.household.id)).last_run_at, first);
  await f.retention.update(f.owner.user.id, f.owner.household.id, { enabled: false, password });
  assert.equal((await f.retention.run()).households.length, 0);
});

test('保留中途数据库错误回滚所有删除与运行时间，不留下半次清理', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.ingest(f.event());
  f.advance(3 * day); await enable(f);
  const before = await snapshot(f.db), original = f.db.run.bind(f.db);
  f.db.run = async (sql, ...params) => {
    if (sql.startsWith('UPDATE device_events SET payload_json=')) throw new Error('synthetic retention rollback');
    return original(sql, ...params);
  };
  await assert.rejects(f.retention.execute(f.owner.user.id, f.owner.household.id, { password }), /synthetic retention rollback/);
  f.db.run = original;
  assert.equal(await snapshot(f.db), before);
});
