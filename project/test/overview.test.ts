import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db, Row } from '../src/db';
import { CareService } from '../src/care';
import { DevicesService, provisionDevice } from '../src/devices';
import { FencesService } from '../src/fences';
import { NotificationService } from '../src/notifications';
import { ReportingService } from '../src/reporting';
import { SafetyService } from '../src/safety';

const status = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
beforeEach(() => { process.env.DATA_MODE = 'offline'; process.env.FRESH_SECONDS = '300'; process.env.OFFLINE_SECONDS = '300'; });

async function fixture() {
  let now = Date.parse('2026-11-17T06:00:00Z'), seq = 0;
  const db = new Db(':memory:', () => new Date(now));
  const owner = db.id(), viewer = db.id(), outsider = db.id(), home = db.id(), otherHome = db.id(), pet = db.id(), sibling = db.id(), otherPet = db.id();
  for (const id of [owner, viewer, outsider]) await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', id, `${id}@example.invalid`, 'unused', db.now());
  for (const [household, user] of [[home, owner], [otherHome, outsider]]) {
    await db.run('INSERT INTO households VALUES (?,?,?,?)', household, 'Overview home', user, db.now());
    await db.run('INSERT INTO household_members VALUES (?,?,?,?)', household, user, 'owner', db.now());
    await db.run('INSERT INTO household_settings VALUES (?,?)', household, 'UTC');
  }
  await db.run('INSERT INTO household_members VALUES (?,?,?,?)', home, viewer, 'viewer', db.now());
  for (const [id, household] of [[pet, home], [sibling, home], [otherPet, otherHome]]) await db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)', id, household, 'Overview pet', 'dog', null, null, null, db.now(), db.now());
  const device = await provisionDevice(db, { serial_no: `overview-${db.id()}` });
  const care = new CareService(db), devices = new DevicesService(db), fences = new FencesService(db), notifications = new NotificationService(db), reporting = new ReportingService(db);
  const event = async (target = pet, occurred = db.now(), state = 'open') => {
    const id = db.id();
    await db.run('INSERT INTO safety_events(id,pet_id,device_id,type,occurred_at,details_json,status) VALUES (?,?,?,?,?,?,?)', id, target, device.device_id, 'geofence.exited', occurred, '{}', state);
    return id;
  };
  const notify = async (eventId: string, user = owner, state = 'pending') => {
    const id = db.id();
    await db.run('INSERT INTO notifications(id,user_id,event_id,status,next_attempt_at,created_at) VALUES (?,?,?,?,?,?)', id, user, eventId, state, db.now(), db.now());
    return id;
  };
  const location = async (accuracy = 10, flags: string[] = []) => {
    const id = db.id(), binding = await db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', device.device_id);
    await db.run('INSERT INTO device_events(event_id,device_id,pet_id,binding_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, device.device_id, pet, binding?.id ?? null, 'location.reported', db.now(), db.now(), seq++, 'overview-fixture', '{}', '{}', db.now());
    await db.run('INSERT INTO locations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, id, device.device_id, pet, db.now(), db.now(), 31.23, 121.47, accuracy, 'gnss', seq - 1, 'overview-fixture', JSON.stringify(flags));
    await db.run('UPDATE device_state SET last_location_id=?,last_seen_at=?,reported_at=? WHERE device_id=?', id, db.now(), db.now(), device.device_id);
    return id;
  };
  return { db, owner, viewer, outsider, home, pet, sibling, otherPet, device, care, devices, fences, notifications, reporting, event, notify, location,
    bind: () => devices.claim(owner, { device_id: device.device_id, pet_id: pet, claim_code: device.claim_code }), advance: (ms: number) => { now += ms; } };
}

test('概览保留原字段，历史活动/照护与当前状态时点分开，无数据不推断佩戴或指标为零', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const date = '2026-11-16', input = { pet_id: f.pet, type: 'note', value: { note: 'selected historical day' }, recorded_at: `${date}T02:00:00Z` };
  const record = await f.care.create(f.owner, input);
  const empty = await f.care.overview(f.viewer, f.pet, { date });
  assert.equal(empty.current_state_at, f.db.now()); assert.equal(empty.activity.local_date, date);
  assert.equal(empty.pet.id, f.pet); assert.equal(empty.device, null); assert.equal(empty.location, null);
  assert.deepEqual(empty.geofences, { items: [] }); assert.equal(empty.care_records[0].id, record.id); assert.deepEqual(empty.safety_events, []);
  assert.deepEqual(empty.attention, { open_event_count: 0, unacknowledged_open_event_count: 0, unacknowledged_open_events: [], unread_notification_count: 0, unread_notifications: [] });
  assert.deepEqual(empty.data_gaps, { activity_period: ['activity_missing'], current_state: ['device_unbound', 'location_missing', 'geofence_unconfigured'] });
  assert.equal(empty.activity.steps, null); assert.equal(empty.activity.sleep_minutes, null);
  const id = f.db.id();
  await f.db.run('INSERT INTO device_events(event_id,device_id,pet_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, f.device.device_id, f.pet, 'activity.reported', `${date}T12:00:00.000Z`, f.db.now(), 1, 'activity-fixture', '{}', '{}', f.db.now());
  await f.db.run('INSERT INTO activity_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, id, f.device.device_id, f.pet, `${date}T00:00:00.000Z`, `${date}T12:00:00.000Z`, 0, null, null, null, 0, 'fixture', '{}');
  const partial = await f.care.overview(f.viewer, f.pet, { date });
  assert.deepEqual(partial.data_gaps.activity_period, ['activity_partial']); assert.equal(partial.activity.steps, 0); assert.equal(partial.activity.active_minutes, null);
  await f.db.run('UPDATE activity_samples SET end_at=? WHERE id=?', '2026-11-17T00:00:00.000Z', id);
  assert.deepEqual((await f.care.overview(f.viewer, f.pet, { date })).data_gaps.activity_period, []);
});

test('概览待办统计全部开启事件和本人未读，前五项稳定排序且不受最近十条事件限制', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const pending: { id: string; type: string; status: string; occurred_at: string }[] = [];
  const unread: string[] = [];
  for (let index = 0; index < 7; index++) {
    const occurred = `2026-11-15T${String(index).padStart(2, '0')}:00:00.000Z`, id = await f.event(f.pet, occurred);
    pending.push({ id, type: 'geofence.exited', status: 'open', occurred_at: occurred });
    unread.push(await f.notify(id, f.owner, index % 2 ? 'dead' : 'sent'));
    await f.notify(id, f.viewer);
  }
  const acknowledged = await f.event(); await new SafetyService(f.db).acknowledge(f.owner, acknowledged, {});
  for (let index = 0; index < 12; index++) await f.event(f.pet, `2026-11-16T${String(index).padStart(2, '0')}:00:00.000Z`, 'closed');
  const closed = await f.event(f.pet, f.db.now(), 'closed'); await f.notify(closed);
  await f.notify(await f.event(f.sibling)); await f.notify(await f.event(f.otherPet));
  const readEvent = await f.event(), read = await f.notify(readEvent); await f.notifications.markRead(f.owner, read);
  const result = await f.care.overview(f.owner, f.pet, {});
  assert.equal(result.safety_events.length, 10); assert.ok(!result.safety_events.some((row: Row) => row.id === pending[0].id));
  assert.equal(result.attention.open_event_count, 9); assert.equal(result.attention.unacknowledged_open_event_count, 8);
  assert.deepEqual(result.attention.unacknowledged_open_events.map((row: Row) => ({ ...row })), [{ id: readEvent, type: 'geofence.exited', status: 'open', occurred_at: f.db.now() }, ...pending.slice(3).reverse()]);
  assert.ok(!result.attention.unacknowledged_open_events.some((row: Row) => row.id === acknowledged));
  assert.equal(result.attention.unread_notification_count, 8); assert.equal(result.attention.unread_notifications.length, 5);
  assert.deepEqual(result.attention.unread_notifications.map((row: Row) => row.id), [...unread, (await f.db.get('SELECT id FROM notifications WHERE event_id=? AND user_id=?', closed, f.owner))!.id].sort().reverse().slice(0, 5));
  for (const row of result.attention.unread_notifications) assert.deepEqual(Object.keys(row).sort(), ['created_at', 'event_id', 'id', 'occurred_at', 'status', 'type']);
  const view = await f.care.overview(f.viewer, f.pet, {});
  assert.equal(view.attention.unread_notification_count, 7); assert.ok(view.attention.unread_notifications.every((row: Row) => !unread.includes(row.id)));
});

test('人工确认、风险关闭和本人已读分别改变各自待办，不自动修改另一个状态', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const event = await f.event(), ownerNote = await f.notify(event), viewerNote = await f.notify(event, f.viewer);
  await new SafetyService(f.db).acknowledge(f.owner, event, { note: 'owner following up' });
  const afterAck = await f.care.overview(f.viewer, f.pet, {});
  assert.equal(afterAck.attention.open_event_count, 1); assert.equal(afterAck.attention.unacknowledged_open_event_count, 0); assert.equal(afterAck.attention.unread_notification_count, 1);
  await f.notifications.markRead(f.viewer, viewerNote);
  assert.equal((await f.care.overview(f.viewer, f.pet, {})).attention.unread_notification_count, 0);
  assert.equal((await f.care.overview(f.owner, f.pet, {})).attention.unread_notification_count, 1);
  assert.equal((await f.db.get('SELECT read_at FROM notifications WHERE id=?', ownerNote))!.read_at, null);
  await f.db.run("UPDATE safety_events SET status='closed',closed_at=? WHERE id=?", f.db.now(), event);
  const closed = await f.care.overview(f.owner, f.pet, {});
  assert.equal(closed.attention.open_event_count, 0); assert.equal(closed.attention.unacknowledged_open_event_count, 0); assert.equal(closed.attention.unread_notification_count, 1);
});

test('概览复用围栏和定位有效性，应用策略TTL且差点有可用回退仍保留定位缺口', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.bind();
  const fence = await f.fences.create(f.owner, { pet_id: f.pet, name: 'Overview fence', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
  assert.deepEqual((await f.care.overview(f.viewer, f.pet, {})).data_gaps.current_state, ['device_status_unknown', 'location_missing', 'geofence_state_unknown', 'reporting_unconfigured']);
  const location = await f.location();
  await f.db.run("UPDATE geofence_states SET status='inside',last_judgment='inside',last_ts=?,last_location_id=? WHERE fence_id=?", f.db.now(), location, fence.id);
  const policy = await f.reporting.setPolicy(f.owner, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 });
  await f.reporting.acknowledge(f.device.device_id, policy.command_id, f.device.device_token, { status: 'applied', applied_version: policy.desired_version });
  f.advance(400_000);
  const current = await f.care.overview(f.viewer, f.pet, {});
  assert.ok(current.device);
  assert.equal(current.geofences.items[0].state.effective_status, 'inside'); assert.deepEqual(current.data_gaps.current_state, []);
  assert.equal(current.device.reporting.status, 'applied'); assert.equal(current.device.connection_status, 'online');
  await f.location(500, ['poor_accuracy']);
  await f.db.run("UPDATE geofence_states SET last_judgment='uncertain',last_ts=? WHERE fence_id=?", f.db.now(), fence.id);
  const uncertain = await f.care.overview(f.viewer, f.pet, {});
  assert.ok(uncertain.location);
  assert.equal(uncertain.geofences.items[0].state.effective_status, 'unknown'); assert.ok(uncertain.location.last_usable_location.usable_for_tracking);
  assert.deepEqual(uncertain.data_gaps.current_state, ['location_unusable', 'geofence_state_unknown']);
  await f.db.run("UPDATE geofence_states SET last_judgment='inside' WHERE fence_id=?", fence.id);
  f.advance(1801_000);
  const stale = await f.care.overview(f.viewer, f.pet, {});
  assert.equal(stale.geofences.items[0].state.effective_status, 'unknown');
  assert.deepEqual(stale.data_gaps.current_state, ['device_offline', 'location_unusable', 'geofence_state_unknown']);
  await f.fences.update(f.owner, fence.id, { enabled: false });
  const disabled = await f.care.overview(f.viewer, f.pet, {});
  assert.equal(disabled.geofences.items[0].enabled, false); assert.ok(disabled.data_gaps.current_state.includes('geofence_unconfigured'));
});

test('概览保留pending/failed/applied/expired回执语义，读取过期走失不执行维护或生成命令', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.bind();
  const policy = await f.reporting.setPolicy(f.owner, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 });
  const pending = await f.care.overview(f.owner, f.pet, {});
  assert.ok(pending.device);
  assert.equal(pending.device.reporting.status, 'pending'); assert.equal(pending.device.reporting.applied_version, null);
  await f.reporting.acknowledge(f.device.device_id, policy.command_id, f.device.device_token, { status: 'failed', applied_version: policy.desired_version, error: 'Synthetic rejection' });
  const failed = await f.care.overview(f.owner, f.pet, {}); assert.ok(failed.device); assert.equal(failed.device.reporting.status, 'failed');
  const again = await f.reporting.setPolicy(f.owner, f.device.device_id, { mode: 'home_active', interval_seconds: 120 });
  await f.reporting.acknowledge(f.device.device_id, again.command_id, f.device.device_token, { status: 'applied', applied_version: again.desired_version });
  const lost = await f.reporting.lostMode(f.owner, f.device.device_id, { enabled: true, expires_in_seconds: 60 });
  const active = await f.care.overview(f.owner, f.pet, {}); assert.ok(active.device); assert.equal(active.device.reporting.lost_mode.enabled, true);
  const commands = await f.db.all('SELECT * FROM device_commands ORDER BY id'), sessions = await f.db.all('SELECT * FROM lost_mode_sessions ORDER BY id'), audits = await f.db.all('SELECT * FROM audit_logs ORDER BY id');
  f.advance(61_000);
  const expired = await f.care.overview(f.owner, f.pet, {});
  assert.ok(expired.device);
  assert.equal(expired.device.reporting.command_id, lost.command_id); assert.equal(expired.device.reporting.status, 'expired');
  assert.equal(expired.device.reporting.lost_mode.enabled, false); assert.equal(expired.device.reporting.applied.mode, 'home_active');
  assert.deepEqual(await f.db.all('SELECT * FROM device_commands ORDER BY id'), commands); assert.deepEqual(await f.db.all('SELECT * FROM lost_mode_sessions ORDER BY id'), sessions); assert.deepEqual(await f.db.all('SELECT * FROM audit_logs ORDER BY id'), audits);
});

test('当前共享权限与排队撤权生效，解绑后概览不保留旧绑定的设备、定位或策略', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.bind(); await f.location();
  await assert.rejects(f.care.overview(f.outsider, f.pet, {}), status(404));
  await assert.rejects(f.care.overview(f.viewer, f.otherPet, {}), status(404));
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(done => { release = done; }), locked = new Promise<void>(done => { entered = done; });
  const blocker = f.db.transaction(async () => { entered(); await hold; await f.db.run('DELETE FROM household_members WHERE household_id=? AND user_id=?', f.home, f.viewer); });
  await locked;
  const pending = assert.rejects(f.care.overview(f.viewer, f.pet, {}), status(404));
  release(); await blocker; await pending;
  await f.devices.unbind(f.owner, f.device.device_id);
  const unbound = await f.care.overview(f.owner, f.pet, {});
  assert.equal(unbound.device, null); assert.equal(unbound.location, null); assert.ok(unbound.data_gaps.current_state.includes('device_unbound'));
});
