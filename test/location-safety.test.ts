import 'reflect-metadata';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Db, Row } from '../src/db';
import { DevicesService, provisionDevice } from '../src/devices';
import { FencesService } from '../src/fences';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';

beforeEach(() => {
  process.env.DATA_MODE = 'offline';
  process.env.FRESH_SECONDS = '300';
  process.env.OFFLINE_SECONDS = '300';
});

async function fixture() {
  let time = Date.parse('2026-11-17T06:00:00Z'), seq = 0;
  const db = new Db(':memory:', () => new Date(time)), identity = new IdentityService(db);
  const owner = (await identity.register({ email: 'quality@example.invalid', password: 'Synthetic-password' }));
  const pet = (await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'quality' }));
  const device = (await provisionDevice(db, { serial_no: 'quality-device' })), devices = new DevicesService(db);
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  const telemetry = new TelemetryService(db, devices, new NotificationService(db)), fences = new FencesService(db);
  const advance = (seconds: number) => { time += seconds * 1000; };
  const point = (payload: Row = {}, extra: Row = {}) => ({ schema_version: '1.0', event_id: `quality-event-${++seq}`,
    device_id: device.device_id, event_type: 'location.reported', device_ts: db.now(), boot_id: 'quality-boot', seq,
    payload: { lat: 0.003, lon: 0, accuracy_m: 5, source: 'gnss', ...payload }, ...extra });
  const send = async (payload: Row = {}, extra: Row = {}) => {
    const event = point(payload, extra);
    await telemetry.ingest(event, device.device_token); await telemetry.work();
    return event;
  };
  const fence = async (config: Row = {}, key?: string) => (await fences.create(owner.user.id,
    { pet_id: pet.id, name: 'home', geometry: { type: 'circle', lat: 0, lon: 0, radius_m: 100 }, ...config }, key)) as Row;
  return { db, identity, owner, pet, device, devices, telemetry, fences, advance, point, send, fence };
}

test('dynamic accuracy buffer is opt-in and persists the effective buffer and rule version', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const fixed = (await f.fence()), dynamic = (await f.fence({ name: 'dynamic', dynamic_buffer: true }));
  await f.send({ lat: 0.00135, accuracy_m: 70 });
  f.advance(10); await f.send({ lat: 0.00135, accuracy_m: 70 });
  assert.equal((await f.db.get('SELECT status FROM geofence_states WHERE fence_id=?', fixed.id))!.status, 'outside');
  assert.equal((await f.db.get('SELECT status FROM geofence_states WHERE fence_id=?', dynamic.id))!.status, 'unknown');
  const evaluation = (await f.db.get('SELECT * FROM geofence_evaluations WHERE fence_id=? ORDER BY rowid DESC LIMIT 1', dynamic.id))!;
  assert.equal(evaluation.reason, 'boundary_buffer');
  assert.equal(evaluation.effective_buffer_m, 70);
  assert.equal(evaluation.rule_version, 1);
  const changed = (await f.fences.update(f.owner.user.id, dynamic.id, { min_exit_seconds: 30 })) as Row;
  assert.equal(changed.rule_version, 2);
  assert.equal(changed.state.candidate_since, null);
});

test('exit and return require both fresh points and minimum duration; a timer alone cannot confirm', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const fence = (await f.fence({ min_exit_seconds: 30, min_enter_seconds: 20 }));
  await f.send(); f.advance(10); await f.send();
  assert.equal((await f.db.get('SELECT COUNT(*) n FROM safety_events'))!.n, 0);
  assert.equal((await f.db.get('SELECT count FROM geofence_states'))!.count, 2);
  f.advance(20);
  assert.equal((await f.db.get('SELECT COUNT(*) n FROM safety_events'))!.n, 0);
  await f.send();
  assert.equal((await f.db.get('SELECT status FROM geofence_states WHERE fence_id=?', fence.id))!.status, 'outside');
  f.advance(10); await f.send({ lat: 0 }); f.advance(10); await f.send({ lat: 0 });
  assert.equal((await f.db.get('SELECT status FROM geofence_states'))!.status, 'outside');
  f.advance(10); await f.send({ lat: 0 });
  assert.equal((await f.db.get('SELECT status FROM geofence_states'))!.status, 'inside');
  assert.equal((await f.db.get("SELECT COUNT(*) n FROM safety_events WHERE type='geofence.exited' AND status='closed'"))!.n, 1);
});

test('non-GNSS and poor points stay visible but cannot confirm fences; usable fallback stays in current binding', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close())); await f.fence();
  const valid = (await f.send()); f.advance(10);
  await f.send({ source: 'wifi' });
  let latest = (await f.telemetry.latest(f.owner.user.id, f.pet.id))!;
  assert.equal(latest.source, 'wifi');
  assert.equal(latest.usable_for_tracking, false);
  assert.equal(latest.usable_for_geofence, false);
  assert.equal(latest.last_usable_location.event_id, valid.event_id);
  assert.equal((await f.db.get('SELECT count FROM geofence_states'))!.count, 0);
  assert.equal((await f.db.get('SELECT reason FROM geofence_evaluations ORDER BY rowid DESC LIMIT 1'))!.reason, 'source_not_allowed');
  f.advance(10); await f.send();
  assert.equal((await f.db.get('SELECT COUNT(*) n FROM safety_events'))!.n, 0);
  f.advance(10); await f.send();
  assert.equal((await f.db.get("SELECT COUNT(*) n FROM safety_events WHERE type='geofence.exited'"))!.n, 1);
  const code = (await f.devices.unbind(f.owner.user.id, f.device.device_id));
  await f.devices.claim(f.owner.user.id, { ...code, pet_id: f.pet.id });
  f.advance(10); await f.send({ accuracy_m: 300 });
  latest = (await f.telemetry.latest(f.owner.user.id, f.pet.id))!;
  assert.equal(latest.usable_for_tracking, false);
  assert.equal(latest.last_usable_location, null);
});

test('future and out-of-order audit reasons retain rule identity without moving the fence watermark', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close())); const fence = (await f.fence());
  const valid = (await f.send());
  f.advance(10); await f.send({}, { device_ts: '2030-11-17T06:00:00Z' });
  await f.send({}, { device_ts: '2026-11-17T05:59:59Z' });
  const state = (await f.db.get('SELECT * FROM geofence_states WHERE fence_id=?', fence.id))!;
  assert.equal(state.last_ts, valid.device_ts);
  assert.equal(state.count, 0);
  assert.deepEqual((await f.db.all('SELECT reason FROM geofence_evaluations ORDER BY rowid')).map(row => row.reason), ['valid', 'clock_ahead', 'out_of_order']);
});

test('geofence eligibility explains custom accuracy without loosening tracking or accepting speed and stale points', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  await f.send({ lat: 0, accuracy_m: 150 });
  let latest = (await f.telemetry.latest(f.owner.user.id, f.pet.id))!;
  assert.equal(latest.usable_for_tracking, false);
  assert.equal(latest.usable_for_geofence, false);
  assert.equal(latest.geofence_accuracy_limit_m, 100);
  const fence = (await f.fence({ accuracy_limit_m: 200 }));
  latest = (await f.telemetry.latest(f.owner.user.id, f.pet.id))!;
  assert.equal(latest.usable_for_tracking, false);
  assert.equal(latest.usable_for_geofence, true);
  assert.equal(latest.geofence_accuracy_limit_m, 200);
  assert.deepEqual(latest.quality_flags, ['poor_accuracy']);
  await f.fences.update(f.owner.user.id, fence.id, { enabled: false });
  assert.equal((await f.telemetry.latest(f.owner.user.id, f.pet.id))!.geofence_accuracy_limit_m, 100);
  assert.equal((await f.telemetry.latest(f.owner.user.id, f.pet.id))!.usable_for_geofence, false);
  await f.fences.update(f.owner.user.id, fence.id, { enabled: true });
  f.advance(600);
  assert.equal((await f.telemetry.latest(f.owner.user.id, f.pet.id))!.usable_for_geofence, false);
  await f.send({ lat: 0 }); f.advance(10); await f.send({ lat: 20, accuracy_m: 150 });
  latest = (await f.telemetry.latest(f.owner.user.id, f.pet.id))!;
  assert.ok(latest.quality_flags.includes('implausible_speed'));
  assert.equal(latest.usable_for_geofence, false);
});

test('an implausible jump cannot poison the speed reference for the next good point', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close())); await f.fence();
  await f.send({ lat: 0 }); f.advance(10);
  await f.send({ lat: 20 });
  assert.ok((await f.telemetry.latest(f.owner.user.id, f.pet.id))!.quality_flags.includes('implausible_speed'));
  f.advance(10); await f.send({ lat: 0 });
  const latest = (await f.telemetry.latest(f.owner.user.id, f.pet.id))!;
  assert.deepEqual(latest.quality_flags, []);
  assert.equal(latest.usable_for_tracking, true);
  assert.equal((await f.db.get('SELECT status FROM geofence_states'))!.status, 'inside');
});

test('telemetry retains transport metadata and actual queue/processing timestamps; history range is bounded', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const event = f.point({}, { transport: 'simulator', source_metadata: { vendor_event_id: 'raw-42', sensor_algorithm: 'fixture-v1' } });
  await f.telemetry.ingest(event, f.device.device_token);
  assert.equal((await f.telemetry.event(f.owner.user.id, event.event_id)).queue_delay_ms, null);
  f.advance(2); await f.telemetry.work();
  const processed = (await f.telemetry.event(f.owner.user.id, event.event_id));
  assert.equal(processed.queue_delay_ms, 2000);
  assert.equal(processed.processing_delay_ms, 2000);
  const stored = JSON.parse((await f.db.get('SELECT envelope_json FROM device_events WHERE event_id=?', event.event_id))!.envelope_json);
  assert.equal(stored.transport, 'simulator');
  assert.equal(stored.source_metadata.vendor_event_id, 'raw-42');
  const page = (await f.telemetry.locations(f.owner.user.id, f.pet.id, {}));
  assert.equal(page.items.length, 1);
  assert.equal(Date.parse(page.range.to) - Date.parse(page.range.from), 86400_000);
  await assert.rejects(async () => (await f.telemetry.locations(f.owner.user.id, f.pet.id,
    { from: '2026-09-01T00:00:00Z', to: '2026-11-17T00:00:00Z' })), error => error instanceof HttpException && error.getStatus() === 400);
});

test('fence creation idempotency replays one result, rejects changed input and rechecks current permissions', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const first = (await f.fence({}, 'same-fence'));
  assert.equal((await f.fence({}, 'same-fence')).id, first.id);
  assert.equal((await f.db.get('SELECT COUNT(*) n FROM geofences'))!.n, 1);
  await assert.rejects(async () => (await f.fence({ name: 'changed' }, 'same-fence')), error => error instanceof HttpException && error.getStatus() === 409);
  const caregiver = (await f.identity.register({ email: 'fence-caregiver@example.invalid', password: 'Synthetic-password' }));
  const invite = (await f.identity.invite(f.owner.user.id, f.owner.household.id, { email: caregiver.user.email, role: 'caregiver' }));
  await f.identity.accept(caregiver.user.id, invite.token);
  const input = { pet_id: f.pet.id, name: 'shared', geometry: { type: 'circle', lat: 0, lon: 0, radius_m: 100 } };
  await f.fences.create(caregiver.user.id, input, 'shared-key');
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id);
  await assert.rejects(async () => (await f.fences.create(caregiver.user.id, input, 'shared-key')), error => error instanceof HttpException && error.getStatus() === 404);
});
