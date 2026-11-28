import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db, Row } from '../src/db';
import { DevicesService, provisionDevice } from '../src/devices';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { PrivacyService } from '../src/privacy';
import { TelemetryService } from '../src/telemetry';
import { InventoryRetentionService } from '../src/inventory-retention';

const password = 'Synthetic-inventory-retention-2026', day = 86400000;
const status = (code: number, errorCode?: string) => (error: unknown) => error instanceof HttpException && error.getStatus() === code
  && (!errorCode || (error.getResponse() as Row).code === errorCode);
beforeEach(() => { process.env.DATA_MODE = 'offline'; process.env.DEVICE_ADMIN_USER_IDS = ''; });

async function fixture() {
  let time = Date.parse('2026-11-01T06:00:00Z'), seq = 0;
  const db = new Db(':memory:', () => new Date(time)), identity = new IdentityService(db), devices = new DevicesService(db);
  const register = (name: string) => identity.register({ email: `${name}@example.invalid`, password });
  const admin = await register('inventory-admin'), owner = await register('inventory-owner');
  process.env.DEVICE_ADMIN_USER_IDS = admin.user.id;
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Inventory isolation pet' });
  const device = await provisionDevice(db, { serial_no: 'INVENTORY-RETENTION' });
  const telemetry = new TelemetryService(db, devices, new NotificationService(db)), retention = new InventoryRetentionService(db);
  const event = (payload: Row = { battery_pct: 25, signal: { private: 'inventory-private-signal' } }, extra: Row = {}) => ({
    schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, device_ts: db.now(), seq: ++seq,
    boot_id: 'inventory-retention-boot', event_type: 'state.reported', source_metadata: { private: 'inventory-vendor-private' }, payload, ...extra
  });
  const ingest = async (packet: Row, token = device.device_token) => { await telemetry.ingest(packet, token); await telemetry.work(); return packet; };
  const enable = (values: Row = {}) => retention.update(admin.user.id, { password, enabled: true, telemetry_days: 2, ...values });
  return { db, identity, devices, admin, owner, pet, device, telemetry, retention, event, ingest, enable,
    advance: (milliseconds: number) => { time += milliseconds; } };
}

async function snapshot(db: Db) {
  const result: Row = {};
  for (const row of await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) result[row.name] = await db.all(`SELECT * FROM ${row.name} ORDER BY rowid`);
  return JSON.stringify(result);
}

test('库存保留默认关闭：设备管理员及密码校验、关闭策略零写预览和注销身份拒绝', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const before = await snapshot(f.db);
  assert.equal((await f.retention.read(f.admin.user.id)).enabled, false);
  assert.equal((await f.retention.run()).skipped, 'disabled');
  await assert.rejects(f.retention.read(f.owner.user.id), status(403));
  await assert.rejects(f.retention.update(f.owner.user.id, { password, enabled: true }), status(403));
  await assert.rejects(f.retention.preview(f.owner.user.id), status(403));
  await assert.rejects(f.enable({ password: 'Wrong-inventory-password' }), status(401));
  await assert.rejects(f.enable({ telemetry_days: 0 }));
  assert.equal(await snapshot(f.db), before);
  await f.ingest(f.event()); f.advance(3 * day);
  await f.enable({ enabled: false });
  const disabled = await snapshot(f.db);
  assert.equal((await f.retention.preview(f.admin.user.id)).counts.telemetry_payloads, 1);
  assert.equal((await f.retention.execute(f.admin.user.id, { password })).skipped, 'disabled');
  assert.equal(await snapshot(f.db), disabled);
  await f.enable();
  assert.ok(!JSON.stringify(await f.db.all('SELECT * FROM audit_logs')).includes(password));
  await new PrivacyService(f.db).closeAccount(f.admin.user.id, { password, confirmation: 'DELETE' });
  await assert.rejects(f.retention.read(f.admin.user.id), status(403));
  await assert.rejects(f.retention.update(f.admin.user.id, { password, enabled: true }), status(403));
});

test('库存原文到期：清除旧消息并终止积压，保留去重身份、删除墓碑及家庭业务', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const old = await f.ingest(f.event());
  const pending = f.event(); await f.telemetry.ingest(pending, f.device.device_token);
  await f.db.run('UPDATE device_events SET next_attempt_at=? WHERE event_id=?', '2030-01-01T00:00:00.000Z', pending.event_id);
  const deleted = f.event(); await f.telemetry.ingest(deleted, f.device.device_token);
  await f.db.run("UPDATE device_events SET payload_json='{}',envelope_json='{}',process_status='dead',error='DATA_DELETED' WHERE event_id=?", deleted.event_id);
  const tombstone = await f.db.get('SELECT * FROM device_events WHERE event_id=?', deleted.event_id);
  const familyDevice = await provisionDevice(f.db, { serial_no: 'INVENTORY-FAMILY-CONTROL' });
  await f.devices.claim(f.owner.user.id, { ...familyDevice, pet_id: f.pet.id });
  const family = await f.ingest(f.event({ lat: 31.23, lon: 121.47, accuracy_m: 5, source: 'gnss', signal: { private: 'keep-family-signal' } },
    { device_id: familyDevice.device_id, event_type: 'location.reported' }), familyDevice.device_token);
  const familyState = await f.db.get('SELECT * FROM device_state WHERE device_id=?', familyDevice.device_id);
  f.advance(3 * day);
  const current = await f.ingest(f.event({ battery_pct: 80, signal: { private: 'keep-current-inventory' } }));
  await f.enable();
  const before = await snapshot(f.db), preview = await f.retention.preview(f.admin.user.id);
  assert.equal(preview.counts.telemetry_payloads, 2);
  assert.equal(await snapshot(f.db), before);
  const actual = await f.retention.execute(f.admin.user.id, { password });
  assert.deepEqual(actual.counts, preview.counts);
  for (const packet of [old, pending]) {
    const row = (await f.db.get('SELECT * FROM device_events WHERE event_id=?', packet.event_id))!;
    assert.equal(row.payload_json, '{}'); assert.equal(row.envelope_json, '{}');
    assert.equal(row.pet_id, null); assert.equal(row.binding_id, null);
    assert.equal(row.boot_id, packet.boot_id); assert.equal(row.seq, packet.seq);
  }
  assert.equal((await f.db.get('SELECT process_status FROM device_events WHERE event_id=?', pending.event_id))!.process_status, 'dead');
  assert.equal((await f.db.get('SELECT error FROM device_events WHERE event_id=?', pending.event_id))!.error, 'RETENTION_EXPIRED');
  assert.deepEqual(await f.db.get('SELECT * FROM device_events WHERE event_id=?', deleted.event_id), tombstone);
  for (const packet of [family, current]) assert.notEqual((await f.db.get('SELECT envelope_json FROM device_events WHERE event_id=?', packet.event_id))!.envelope_json, '{}');
  assert.deepEqual(await f.db.get('SELECT * FROM device_state WHERE device_id=?', familyDevice.device_id), familyState);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM locations WHERE pet_id=?', f.pet.id))!.n, 1);
  await assert.rejects(f.telemetry.ingest(old, f.device.device_token), status(409, 'EVENT_DATA_EXPIRED'));
  assert.equal(await f.telemetry.work(), 0);
});

test('库存信号按原始消息来源到期，省略signal的新心跳不能延长旧signal保留时间', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const old = await f.ingest(f.event()); f.advance(3 * day);
  const heartbeat = await f.ingest(f.event({ battery_pct: 80 }));
  const state = (await f.db.get('SELECT * FROM device_state WHERE device_id=?', f.device.device_id))!;
  assert.equal(state.signal_event_id, old.event_id); assert.equal(state.reported_at, heartbeat.device_ts);
  const legacy = await provisionDevice(f.db, { serial_no: 'INVENTORY-LEGACY-SIGNAL' });
  await f.db.run('UPDATE device_state SET signal_json=?,reported_at=? WHERE device_id=?', '{"private":"unknown-old-source"}', f.db.now(), legacy.device_id);
  const family = await provisionDevice(f.db, { serial_no: 'INVENTORY-LEGACY-FAMILY' });
  await f.devices.claim(f.owner.user.id, { ...family, pet_id: f.pet.id });
  await f.db.run('UPDATE device_state SET signal_json=?,reported_at=? WHERE device_id=?', '{"private":"keep-unknown-family-source"}', f.db.now(), family.device_id);
  const familyState = await f.db.get('SELECT * FROM device_state WHERE device_id=?', family.device_id);
  await f.enable();
  const preview = await f.retention.preview(f.admin.user.id);
  assert.equal(preview.counts.device_signal, 2);
  await f.retention.execute(f.admin.user.id, { password });
  const cleared = (await f.db.get('SELECT * FROM device_state WHERE device_id=?', f.device.device_id))!;
  assert.equal(cleared.signal_json, null); assert.equal(cleared.signal_event_id, null); assert.equal(cleared.battery_pct, 80);
  assert.equal((await f.db.get('SELECT signal_json FROM device_state WHERE device_id=?', legacy.device_id))!.signal_json, null);
  assert.deepEqual(await f.db.get('SELECT * FROM device_state WHERE device_id=?', family.device_id), familyState);
  assert.notEqual((await f.db.get('SELECT envelope_json FROM device_events WHERE event_id=?', heartbeat.event_id))!.envelope_json, '{}');
});

test('旧库存消息后来进入家庭仍清原文，但当前家庭signal及位置不受库存策略影响', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const inventory = await f.ingest(f.event());
  f.advance(1000); await f.devices.claim(f.owner.user.id, { ...f.device, pet_id: f.pet.id });
  f.advance(3 * day);
  const current = await f.ingest(f.event({ lat: 31.23, lon: 121.47, accuracy_m: 5, source: 'gnss', signal: { private: 'current-family-private' } }, { event_type: 'location.reported' }));
  const familyState = await f.db.get('SELECT * FROM device_state WHERE device_id=?', f.device.device_id);
  await f.enable(); await f.retention.execute(f.admin.user.id, { password });
  assert.equal((await f.db.get('SELECT envelope_json FROM device_events WHERE event_id=?', inventory.event_id))!.envelope_json, '{}');
  assert.notEqual((await f.db.get('SELECT envelope_json FROM device_events WHERE event_id=?', current.event_id))!.envelope_json, '{}');
  assert.deepEqual(await f.db.get('SELECT * FROM device_state WHERE device_id=?', f.device.device_id), familyState);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM locations WHERE pet_id=?', f.pet.id))!.n, 1);
});

test('绑定转换清空旧状态，库存及旧绑定排队消息不污染新家庭状态', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.ingest(f.event());
  const stock = f.event({ battery_pct: 1, signal: { private: 'queued-inventory-must-not-leak' } }, { device_ts: new Date(Date.parse(f.db.now()) + 50000).toISOString() });
  await f.telemetry.ingest(stock, f.device.device_token);
  f.advance(1000); await f.devices.claim(f.owner.user.id, { ...f.device, pet_id: f.pet.id });
  const empty = (await f.db.get('SELECT * FROM device_state WHERE device_id=?', f.device.device_id))!;
  for (const key of ['signal_json','signal_event_id','reported_at','reported_seq','reported_boot_id','battery_pct','last_seen_at']) assert.equal(empty[key], null, key);
  const first = await f.ingest(f.event({ battery_pct: 90, signal: { private: 'first-family-signal' } }));
  assert.equal((await f.db.get('SELECT signal_event_id FROM device_state WHERE device_id=?', f.device.device_id))!.signal_event_id, first.event_id);
  const oldBound = f.event({ battery_pct: 2, signal: { private: 'old-family-queue-must-not-leak' } }, { device_ts: new Date(Date.parse(f.db.now()) + 50000).toISOString() });
  await f.telemetry.ingest(oldBound, f.device.device_token);
  const claim = await f.devices.unbind(f.owner.user.id, f.device.device_id);
  assert.equal((await f.db.get('SELECT signal_json FROM device_state WHERE device_id=?', f.device.device_id))!.signal_json, null);
  await f.devices.release(f.owner.user.id, f.device.device_id);
  const nextPet = await f.identity.createPet(f.admin.user.id, { household_id: f.admin.household.id, name: 'Next family pet' });
  f.advance(1000); await f.devices.claim(f.admin.user.id, { ...claim, pet_id: nextPet.id });
  const second = await f.ingest(f.event({ battery_pct: 85, signal: { private: 'second-family-signal' } }));
  const current = (await f.db.get('SELECT * FROM device_state WHERE device_id=?', f.device.device_id))!;
  assert.equal(current.signal_event_id, second.event_id); assert.equal(current.battery_pct, 85);
  assert.ok(!current.signal_json.includes('must-not-leak'));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM locations WHERE pet_id=?', nextPet.id))!.n, 0);
});

test('库存保留持久化小时冷却，强制预览和关闭策略均不执行清理', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.enable(); await f.retention.run();
  const first = (await f.retention.read(f.admin.user.id)).last_run_at;
  assert.ok(first); assert.equal((await f.retention.run()).skipped, 'not_due');
  await f.retention.preview(f.admin.user.id);
  assert.equal((await f.retention.read(f.admin.user.id)).last_run_at, first);
  f.advance(3600000); assert.equal((await f.retention.run()).skipped, undefined);
  assert.notEqual((await f.retention.read(f.admin.user.id)).last_run_at, first);
  await f.enable({ enabled: false });
  assert.equal((await f.retention.run(false, true)).skipped, 'disabled');
});

test('库存清理失败完整回滚原文、signal及运行时间，不留下半次清理', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.ingest(f.event()); f.advance(3 * day); await f.enable();
  const before = await snapshot(f.db), original = f.db.run.bind(f.db);
  f.db.run = async (sql, ...params) => {
    if (sql.startsWith('UPDATE device_events') && sql.includes('payload_json')) throw new Error('synthetic inventory rollback');
    return original(sql, ...params);
  };
  await assert.rejects(f.retention.execute(f.admin.user.id, { password }), /synthetic inventory rollback/);
  f.db.run = original;
  assert.equal(await snapshot(f.db), before);
});
