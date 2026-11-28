import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { SQLInputValue } from 'node:sqlite';
import { Db, Row } from '../src/db';
import { DevicesService, provisionDevice } from '../src/devices';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';
import { OperationsService } from '../src/operations';

beforeEach(() => {
  process.env.DATA_MODE = 'offline';
  process.env.FRESH_SECONDS = '300';
  process.env.OFFLINE_SECONDS = '300';
  process.env.LOW_BATTERY_PCT = '20';
});
const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
const reason = { reason: 'Retry after worker maintenance' };

async function fixture() {
  let time = Date.parse('2026-11-17T06:00:00Z'), seq = 0;
  const db = new Db(':memory:', () => new Date(time));
  const identity = new IdentityService(db), devices = new DevicesService(db), notifications = new NotificationService(db);
  const register = (name: string) => identity.register({ email: `${name}@example.invalid`, password: 'Synthetic-operations-2026' });
  const owner = await register('owner'), viewer = await register('viewer'), caregiver = await register('caregiver'), outsider = await register('outsider');
  for (const [user, role] of [[viewer, 'viewer'], [caregiver, 'caregiver']] as const) {
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: user.user.email, role });
    await identity.accept(user.user.id, invitation.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '运营合成宠物' });
  const device = await provisionDevice(db, { serial_no: 'OPERATIONS-TEST' });
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  const telemetry = new TelemetryService(db, devices, notifications), operations = new OperationsService(db);
  const packet = (type = 'location.reported', payload: Row = { lat: 31.234567, lon: 121.456789, accuracy_m: 5, source: 'gnss', signal: { private: 'payload-sentinel' } }) => ({
    schema_version: '1.0', event_id: `operations-event-${++seq}`, device_id: device.device_id, device_ts: db.now(),
    seq, boot_id: 'operations-boot', event_type: type, payload
  });
  const dead = async () => {
    const event = packet(); await telemetry.ingest(event, device.device_token);
    await db.run("UPDATE device_events SET process_status='dead',attempts=5,error='Error',processing_started_at=?,processed_at=?,next_attempt_at=? WHERE event_id=?",
      db.now(), db.now(), new Date(time + 60000).toISOString(), event.event_id);
    return event;
  };
  return { db, identity, devices, notifications, telemetry, operations, owner, viewer, caregiver, outsider, pet, device, packet, dead,
    advance: (milliseconds: number) => { time += milliseconds; } };
}

test('运营失败列表仅返回当前绑定元数据，支持分页和状态筛选且不泄露上报内容', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const old = await f.dead();
  const renewal = await f.devices.unbind(f.owner.user.id, f.device.device_id);
  await f.devices.claim(f.owner.user.id, { ...renewal, pet_id: f.pet.id });
  f.advance(1000); const first = await f.dead();
  f.advance(1000); const second = await f.dead();
  await f.db.run("UPDATE device_events SET process_status='retry' WHERE event_id=?", second.event_id);
  const page = await f.operations.failures(f.viewer.user.id, f.pet.id, { limit: 1 });
  assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
  const next = await f.operations.failures(f.owner.user.id, f.pet.id, { limit: 1, cursor: page.next_cursor });
  assert.equal(next.items.length, 1); assert.notEqual(next.items[0].event_id, page.items[0].event_id);
  assert.deepEqual(new Set([page.items[0].event_id, next.items[0].event_id]), new Set([first.event_id, second.event_id]));
  assert.equal(next.next_cursor, null);
  const filtered = await f.operations.failures(f.owner.user.id, f.pet.id, { status: 'dead' });
  assert.deepEqual(filtered.items.map((row: Row) => row.event_id), [first.event_id]);
  const serialized = JSON.stringify({ page, next });
  for (const privateValue of ['payload_json', 'envelope_json', 'payload-sentinel', '31.234567', '121.456789', f.device.device_token, f.device.claim_code, old.event_id]) {
    assert.ok(!serialized.includes(privateValue), privateValue);
  }
  await assert.rejects(f.operations.failures(f.outsider.user.id, f.pet.id, {}), status(404));
  await assert.rejects(f.operations.failures(f.owner.user.id, f.pet.id, { cursor: old.event_id }), status(400));
  await assert.rejects(f.operations.failures(f.owner.user.id, f.pet.id, { limit: 101 }));
});

test('失败列表第一页游标被重排或处理后，仍能继续读取剩余失败记录', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const older = await f.dead(); f.advance(1000); const newer = await f.dead();
  const first = await f.operations.failures(f.owner.user.id, f.pet.id, { status: 'dead', limit: 1 });
  assert.equal(first.items[0].event_id, newer.event_id); assert.equal(first.next_cursor, newer.event_id);
  await f.operations.retry(f.owner.user.id, newer.event_id, reason);
  const query = { status: 'dead', limit: 1, cursor: first.next_cursor };
  const whilePending = await f.operations.failures(f.owner.user.id, f.pet.id, query);
  assert.deepEqual(whilePending.items.map((row: Row) => row.event_id), [older.event_id]);
  await f.telemetry.work();
  assert.equal((await f.db.get('SELECT process_status FROM device_events WHERE event_id=?', newer.event_id))!.process_status, 'processed');
  const afterProcessed = await f.operations.failures(f.owner.user.id, f.pet.id, query);
  assert.deepEqual(afterProcessed.items.map((row: Row) => row.event_id), [older.event_id]);
  assert.equal(afterProcessed.next_cursor, null);
});

test('死信重试只重排原事件，Worker继续处理且原Envelope和payload保持不变', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const event = await f.dead(), before = (await f.db.get('SELECT * FROM device_events WHERE event_id=?', event.event_id))!;
  await f.operations.retry(f.caregiver.user.id, event.event_id, reason, 'recover-event');
  const queued = (await f.db.get('SELECT * FROM device_events WHERE event_id=?', event.event_id))!;
  assert.equal(queued.process_status, 'pending'); assert.equal(queued.attempts, 0); assert.equal(queued.error, null);
  assert.equal(queued.next_attempt_at, f.db.now()); assert.equal(queued.processing_started_at, null); assert.equal(queued.processed_at, null);
  assert.equal(queued.envelope_json, before.envelope_json); assert.equal(queued.payload_json, before.payload_json);
  assert.equal(queued.received_at, before.received_at); assert.equal(queued.binding_id, before.binding_id);
  const audit = (await f.db.get("SELECT * FROM audit_logs WHERE action='telemetry.retry'"))!;
  assert.equal(audit.actor_id, f.caregiver.user.id); assert.equal(audit.resource_id, event.event_id);
  assert.equal(JSON.parse(audit.metadata_json).reason, reason.reason);
  assert.equal(await f.telemetry.work(), 1);
  assert.equal((await f.db.get('SELECT process_status FROM device_events WHERE event_id=?', event.event_id))!.process_status, 'processed');
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM locations WHERE event_id=?', event.event_id))!.n, 1);
});

test('重试幂等仅生成一次审计，异内容冲突且已处理结果不会被重复投影', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const event = await f.dead();
  const first = await f.operations.retry(f.owner.user.id, event.event_id, reason, 'retry-idempotency');
  assert.deepEqual(await f.operations.retry(f.owner.user.id, event.event_id, reason, 'retry-idempotency'), first);
  await assert.rejects(f.operations.retry(f.owner.user.id, event.event_id, { reason: 'Different maintenance reason' }, 'retry-idempotency'), status(409));
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='telemetry.retry'"))!.n, 1);
  await f.telemetry.work();
  assert.deepEqual(await f.operations.retry(f.owner.user.id, event.event_id, reason, 'retry-idempotency'), first);
  await assert.rejects(f.operations.retry(f.owner.user.id, event.event_id, reason), status(409));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM locations WHERE event_id=?', event.event_id))!.n, 1);
});

test('失败重排要求当前写权限，viewer/跨家庭被拒绝且pending和processed不能重排', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const event = await f.dead();
  await assert.rejects(f.operations.retry(f.viewer.user.id, event.event_id, reason), status(403));
  await assert.rejects(f.operations.retry(f.outsider.user.id, event.event_id, reason), status(404));
  const pending = f.packet(); await f.telemetry.ingest(pending, f.device.device_token);
  await assert.rejects(f.operations.retry(f.owner.user.id, pending.event_id, reason), status(409));
  await f.telemetry.work();
  await assert.rejects(f.operations.retry(f.owner.user.id, pending.event_id, reason), status(409));
  await assert.rejects(f.operations.retry(f.owner.user.id, event.event_id, { reason: '' }));
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='telemetry.retry'"))!.n, 0);
});

test('撤权和重新绑定后旧重试键不可读取缓存或重新排入历史绑定事件', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const event = await f.dead();
  await f.operations.retry(f.caregiver.user.id, event.event_id, reason, 'member-retry');
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id);
  await assert.rejects(f.operations.retry(f.caregiver.user.id, event.event_id, reason, 'member-retry'), status(404));
  await f.db.run("UPDATE device_events SET process_status='dead' WHERE event_id=?", event.event_id);
  await f.operations.retry(f.owner.user.id, event.event_id, reason, 'owner-retry');
  const renewal = await f.devices.unbind(f.owner.user.id, f.device.device_id);
  await f.devices.claim(f.owner.user.id, { ...renewal, pet_id: f.pet.id });
  await assert.rejects(f.operations.retry(f.owner.user.id, event.event_id, reason, 'owner-retry'), status(404));
  assert.equal((await f.operations.failures(f.owner.user.id, f.pet.id, {})).items.length, 0);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='telemetry.retry'"))!.n, 2);
});

test('永久性活动重叠错误重试后仍为死信，不修改原消息或重复活动', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const payload = { start_at: '2026-11-17T05:58:00Z', end_at: '2026-11-17T05:59:00Z', steps: 60, active_seconds: 30 };
  await f.telemetry.ingest(f.packet('activity.reported', payload), f.device.device_token); await f.telemetry.work();
  const event = f.packet('activity.reported', payload); await f.telemetry.ingest(event, f.device.device_token); await f.telemetry.work();
  assert.equal((await f.db.get('SELECT process_status FROM device_events WHERE event_id=?', event.event_id))!.process_status, 'dead');
  const before = (await f.db.get('SELECT envelope_json FROM device_events WHERE event_id=?', event.event_id))!.envelope_json;
  await f.operations.retry(f.owner.user.id, event.event_id, reason);
  assert.equal(await f.telemetry.work(), 0);
  const row = (await f.db.get('SELECT * FROM device_events WHERE event_id=?', event.event_id))!;
  assert.equal(row.process_status, 'dead'); assert.equal(row.error, 'ACTIVITY_OVERLAP'); assert.equal(row.envelope_json, before);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM activity_samples'))!.n, 1);
});

test('家庭运营简报区分空样本和未知设备，不将缺失位置或质量比例伪装为零', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const empty = await f.operations.summary(f.outsider.user.id, f.outsider.household.id, {});
  assert.equal(empty.household_id, f.outsider.household.id); assert.equal(empty.mode, 'offline');
  assert.deepEqual(empty.devices, []); assert.equal(empty.totals.devices, 0);
  assert.equal(empty.location_quality.received_points, 0); assert.equal(empty.location_quality.good_point_ratio, null);
  for (const key of ['ingest_delay', 'queue_delay', 'processing_delay']) assert.deepEqual({ ...empty.telemetry[key] }, { samples: 0, p95_ms: null });
  const report = await f.operations.summary(f.viewer.user.id, f.owner.household.id, {});
  assert.equal(report.totals.devices, 1); assert.equal(report.totals.unknown, 1); assert.equal(report.totals.low_battery, 0);
  assert.equal(report.devices[0].location.freshness, 'missing'); assert.equal(report.devices[0].location.age_seconds, null);
  assert.equal(report.devices[0].low_battery, null);
  await assert.rejects(f.operations.summary(f.outsider.user.id, f.owner.household.id, {}), status(404));
  for (const hours of [0, 169, 'invalid']) await assert.rejects(f.operations.summary(f.owner.user.id, f.owner.household.id, { hours }));
});

test('运营简报核对位置质量、分阶段延迟与本人模拟通知，不返回坐标或信号原文', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const good = f.packet('location.reported', { lat: 31.234567, lon: 121.456789, accuracy_m: 5, source: 'gnss', battery_pct: 15, signal: { private: 'payload-sentinel' } });
  await f.telemetry.ingest(good, f.device.device_token); f.advance(2000); await f.telemetry.work();
  f.advance(1000);
  await f.telemetry.ingest(f.packet('location.reported', { lat: 31.234567, lon: 121.456789, accuracy_m: 200, source: 'gnss', battery_pct: 15 }), f.device.device_token);
  await f.telemetry.work(); await f.notifications.dispatch();
  await f.telemetry.ingest(f.packet('state.reported', { battery_pct: 15 }), f.device.device_token);
  const failed = await f.dead();
  await f.db.run('UPDATE device_events SET processing_started_at=NULL,processed_at=NULL WHERE event_id=?', failed.event_id);
  const report = await f.operations.summary(f.viewer.user.id, f.owner.household.id, { hours: 24 });
  assert.equal(report.totals.devices, 1); assert.equal(report.totals.online, 1); assert.equal(report.totals.low_battery, 1);
  assert.equal(report.devices[0].location.usable_for_tracking, false); assert.deepEqual(report.devices[0].location.quality_flags, ['poor_accuracy']);
  assert.equal(report.location_quality.basis, 'projected_locations_received_in_window');
  assert.equal(report.location_quality.received_points, 2); assert.equal(report.location_quality.good_points, 1); assert.equal(report.location_quality.good_point_ratio, .5);
  assert.equal(report.telemetry.event_count, 4); assert.equal(report.telemetry.counts_by_status.processed, 2);
  assert.equal(report.telemetry.clock_ahead_count, 0);
  assert.deepEqual({ ...report.telemetry.ingest_delay }, { samples: 4, p95_ms: 0 });
  assert.deepEqual({ ...report.telemetry.queue_delay }, { samples: 2, p95_ms: 2000 });
  assert.deepEqual({ ...report.telemetry.processing_delay }, { samples: 2, p95_ms: 2000 });
  assert.equal(report.queue.pending, 1); assert.equal(report.queue.dead, 1);
  assert.equal(report.notifications.scope, 'current_user'); assert.equal(report.notifications.counts_by_status.simulated, 1);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM notifications WHERE status='simulated'"))!.n, 3);
  assert.equal(report.open_safety_events.counts_by_type['battery.low'], 1);
  const serialized = JSON.stringify(report);
  for (const value of ['"lat"', '"lon"', 'signal_json', 'payload-sentinel', 'payload_json', 'envelope_json', f.device.device_token, f.device.claim_code]) assert.ok(!serialized.includes(value), value);
});

test('时间窗口裁剪历史指标但保留旧积压，重新绑定后旧队列不进入当前运营范围', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const old = await f.dead();
  f.advance(2 * 3600_000);
  const report = await f.operations.summary(f.owner.user.id, f.owner.household.id, { hours: 1 });
  assert.equal(report.window.hours, 1); assert.equal(report.telemetry.event_count, 0);
  assert.equal(report.queue.dead, 1); assert.equal(report.queue.oldest_unprocessed_age_seconds, 7200);
  assert.equal(report.queue.oldest_unprocessed_received_at, (await f.db.get('SELECT received_at FROM device_events WHERE event_id=?', old.event_id))!.received_at);
  assert.equal(report.totals.offline, 1);
  const renewal = await f.devices.unbind(f.owner.user.id, f.device.device_id);
  await f.devices.claim(f.owner.user.id, { ...renewal, pet_id: f.pet.id });
  const current = await f.operations.summary(f.owner.user.id, f.owner.household.id, { hours: 24 });
  assert.equal(current.telemetry.event_count, 0); assert.equal(current.queue.dead, 0);
  assert.equal(current.queue.oldest_unprocessed_received_at, null); assert.equal(current.queue.oldest_unprocessed_age_seconds, null);
});

test('设备时钟超前单独计数，不把负传输延迟纳入P95或误报当前位置可用', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const event = { ...f.packet(), device_ts: new Date(f.db.clock().getTime() + 120_000).toISOString() };
  await f.telemetry.ingest(event, f.device.device_token); await f.telemetry.work();
  const report = await f.operations.summary(f.owner.user.id, f.owner.household.id, {});
  assert.equal(report.telemetry.clock_ahead_count, 1);
  assert.deepEqual({ ...report.telemetry.ingest_delay }, { samples: 0, p95_ms: null });
  assert.equal(report.location_quality.received_points, 1); assert.equal(report.location_quality.good_points, 0);
  assert.equal(report.location_quality.good_point_ratio, 0);
  assert.equal(report.devices[0].location.freshness, 'missing'); assert.equal(report.devices[0].location.usable_for_tracking, false);
});

test('简报读取期间绑定改变时拒绝混合状态，要求调用者刷新', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const original = f.db.get.bind(f.db);
  let changed = false;
  f.db.get = async <T = Row>(sql: string, ...params: SQLInputValue[]): Promise<T | undefined> => {
    if (!changed && sql.includes('SELECT * FROM device_state WHERE device_id=')) {
      changed = true;
      await f.db.run('UPDATE device_bindings SET unbound_at=? WHERE device_id=? AND unbound_at IS NULL', f.db.now(), f.device.device_id);
      await f.db.run('UPDATE device_state SET battery_pct=7 WHERE device_id=?', f.device.device_id);
    }
    return original<T>(sql, ...params);
  };
  try {
    await assert.rejects(f.operations.summary(f.owner.user.id, f.owner.household.id, {}), (error: unknown) =>
      error instanceof HttpException && error.getStatus() === 409 && (error.getResponse() as Row).code === 'BINDINGS_CHANGED');
    assert.equal(changed, true);
  } finally { f.db.get = original; }
});
