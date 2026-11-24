import 'reflect-metadata';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, Row } from '../src/db';
import { DevicesService, provisionDevice } from '../src/devices';
import { FencesService } from '../src/fences';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';

beforeEach(() => {
  process.env.DATA_MODE = 'offline'; process.env.PUSH_MODE = 'mock';
  process.env.FRESH_SECONDS = '300'; process.env.OFFLINE_SECONDS = '300';
  process.env.LOW_BATTERY_PCT = '20';
});

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
const total = async (db: Db, table: string) => (await db.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n as number;

async function fixture(path = ':memory:') {
  let time = Date.parse('2026-11-17T02:00:00Z'), sequence = 0;
  const clock = () => new Date(time), db = new Db(path, clock), identity = new IdentityService(db);
  const owner = (await identity.register({ email: 'owner@example.com', password: 'password123' }));
  const pet = (await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Doogy' }));
  const device = (await provisionDevice(db, { serial_no: 'doogy-test' })), devices = new DevicesService(db);
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  const notifications = new NotificationService(db), telemetry = new TelemetryService(db, devices, notifications), fences = new FencesService(db);
  const event = (type: string, payload: Row, extra: Row = {}) => ({
    schema_version: '1.0', event_id: `test-event-${++sequence}`, device_id: device.device_id,
    device_ts: db.now(), seq: sequence, boot_id: 'test-boot', event_type: type, payload, ...extra,
  });
  return {
    db, clock, owner, pet, device, devices, identity, notifications, telemetry, fences,
    advance: (ms: number) => { time += ms; },
    location: (lat = 0.003, extra: Row = {}) => event('location.reported', { lat, lon: 0, accuracy_m: 5, source: 'gnss' }, extra),
    activity: (start: string, end: string, extra: Row = {}) => event('activity.reported', { start_at: start, end_at: end, steps: 30, active_seconds: 10 }, extra),
    fence: async () => (await fences.create(owner.user.id, { pet_id: pet.id, name: 'home', geometry: { type: 'circle', lat: 0, lon: 0, radius_m: 100 } })),
  };
}

test('future-clock location remains auditable without poisoning fence ordering or latest position', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close())); const fence = (await f.fence()) as Row;
  const first = f.location(); await f.telemetry.ingest(first, f.device.device_token); await f.telemetry.work();
  assert.equal((await f.db.get('SELECT count FROM geofence_states'))!.count, 1);
  const future = f.location(0.003, { device_ts: '2030-11-17T02:00:00Z' });
  await f.telemetry.ingest(future, f.device.device_token);
  await f.telemetry.work();
  assert.equal((await f.db.get('SELECT last_ts FROM geofence_states WHERE fence_id=?', fence.id))!.last_ts, first.device_ts);
  assert.equal((await f.db.get('SELECT count FROM geofence_states'))!.count, 0);
  assert.equal(((await f.telemetry.latest(f.owner.user.id, f.pet.id)) as Row).event_id, first.event_id);
  assert.deepEqual(JSON.parse((await f.db.get('SELECT quality_flags_json FROM locations WHERE event_id=?', future.event_id))!.quality_flags_json), ['clock_ahead']);
  f.advance(1000); await f.telemetry.ingest(f.location(), f.device.device_token); await f.telemetry.work();
  assert.equal((await total(f.db, 'safety_events')), 0);
  f.advance(1000); await f.telemetry.ingest(f.location(), f.device.device_token); await f.telemetry.work();
  assert.equal((await f.db.get("SELECT COUNT(*) n FROM safety_events WHERE type='geofence.exited'"))!.n, 1);
  assert.equal(((await f.telemetry.latest(f.owner.user.id, f.pet.id)) as Row).device_ts, f.db.now());
});

test('stale inbox backlog records history but cannot confirm a current exit or clear offline alert', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close())); await f.fence();
  await f.telemetry.ingest(f.location(0), f.device.device_token); await f.telemetry.work();
  f.advance(10_000); await f.telemetry.ingest(f.location(), f.device.device_token);
  f.advance(10_000); await f.telemetry.ingest(f.location(), f.device.device_token);
  f.advance(360_000); await f.telemetry.runMaintenance();
  const staleAlert = (await f.db.get("SELECT id FROM safety_events WHERE type='location.stale'"))!;
  assert.equal((await f.devices.status(f.device.device_id)).connection_status, 'offline');
  await f.telemetry.work();
  assert.equal((await total(f.db, 'locations')), 3);
  assert.equal((await f.db.get("SELECT COUNT(*) n FROM safety_events WHERE type='geofence.exited'"))!.n, 0);
  assert.equal((await f.db.get("SELECT status FROM safety_events WHERE type='device.offline'"))!.status, 'open');
  assert.equal((await f.db.get('SELECT status FROM safety_events WHERE id=?', staleAlert.id))!.status, 'open');
  assert.equal((await f.telemetry.latest(f.owner.user.id, f.pet.id))!.freshness, 'stale');
  assert.equal((await f.db.get('SELECT last_judgment FROM geofence_states'))!.last_judgment, 'uncertain');
});

test('ownership transfer excludes pending old binding and late old samples from new pet projections', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const oldTime = f.db.now();
  await f.telemetry.ingest(f.location(30), f.device.device_token);
  await f.telemetry.ingest(f.activity('2026-11-17T01:59:00Z', oldTime), f.device.device_token);
  f.advance(60_000);
  const next = (await f.identity.register({ email: 'new-owner@example.com', password: 'password123' }));
  const pet = (await f.identity.createPet(next.user.id, { household_id: next.household.id, name: 'New pet' }));
  const unbound = (await f.devices.unbind(f.owner.user.id, f.device.device_id));
  await f.devices.release(f.owner.user.id, f.device.device_id);
  await f.devices.claim(next.user.id, { ...unbound, pet_id: pet.id });
  await f.telemetry.ingest(f.location(30, { device_ts: oldTime }), f.device.device_token);
  await f.telemetry.ingest(f.activity(oldTime, f.db.now()), f.device.device_token);
  assert.equal((await f.telemetry.work()), 4);
  assert.equal((await total(f.db, 'locations')), 0); assert.equal((await total(f.db, 'activity_samples')), 0);
  assert.equal((await total(f.db, 'device_events')), 4);
  assert.equal((await f.telemetry.latest(next.user.id, pet.id)), null);
  f.advance(30_000);
  await f.telemetry.ingest(f.location(0), f.device.device_token);
  await f.telemetry.ingest(f.activity('2026-11-17T02:01:10Z', '2026-11-17T02:01:20Z'), f.device.device_token);
  await f.telemetry.work();
  assert.equal((await total(f.db, 'locations')), 1); assert.equal((await total(f.db, 'activity_samples')), 1);
  assert.equal(((await f.telemetry.latest(next.user.id, pet.id)) as Row).lat, 0);
  assert.equal((await f.telemetry.latest(f.owner.user.id, f.pet.id)), null);
});

test('first-ever binding can import offline location and activity history with stale freshness', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close())); await f.fence();
  await f.telemetry.ingest(f.location(0, { device_ts: '2026-11-17T01:50:00Z' }), f.device.device_token);
  await f.telemetry.ingest(f.activity('2026-11-17T01:40:00Z', '2026-11-17T01:45:00Z', { device_ts: '2026-11-17T01:45:00Z' }), f.device.device_token);
  assert.equal((await f.telemetry.work()), 2);
  assert.equal((await total(f.db, 'locations')), 1); assert.equal((await total(f.db, 'activity_samples')), 1);
  const latest = (await f.telemetry.latest(f.owner.user.id, f.pet.id))!;
  assert.equal(latest.freshness, 'stale'); assert.ok(latest.quality_flags.includes('stale'));
  assert.equal((await total(f.db, 'safety_events')), 0);
});

test('device identity, deep duplicate equality, event ID and boot sequence conflict checks', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const packet = f.location(); packet.payload.signal = { rsrp: -100, rssi: -70 };
  await assert.rejects(async () => (await f.telemetry.ingest(packet, 'wrong-device-token')), status(401));
  assert.equal((await total(f.db, 'device_events')), 0);
  assert.equal((await f.telemetry.ingest(packet, f.device.device_token)).duplicate, false);
  const reordered = { ...packet, payload: { ...packet.payload, signal: { rssi: -70, rsrp: -100 } } };
  assert.equal((await f.telemetry.ingest(reordered, f.device.device_token)).duplicate, true);
  await assert.rejects(async () => (await f.telemetry.ingest({ ...packet, payload: { ...packet.payload, lat: 1 } }, f.device.device_token)), status(409));
  await assert.rejects(async () => (await f.telemetry.ingest({ ...packet, event_id: 'another-event-id' }, f.device.device_token)), status(409));
  assert.equal((await f.telemetry.ingest({ ...packet, event_id: 'reboot-event-id', boot_id: 'new-boot' }, f.device.device_token)).duplicate, false);
  await f.telemetry.work(); assert.equal((await total(f.db, 'locations')), 2);
});

test('transient projection failure rolls back location, fence transition and notification before one retry', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close())); await f.fence();
  class FlakyNotifications extends NotificationService {
    failNext = true;
    override async enqueue(id: string) { await super.enqueue(id); if (this.failNext) { this.failNext = false; throw new Error('temporary outage'); } }
  }
  const service = new TelemetryService(f.db, f.devices, new FlakyNotifications(f.db));
  await service.ingest(f.location(), f.device.device_token); await service.work();
  f.advance(1000); const second = f.location(); await service.ingest(second, f.device.device_token);
  assert.equal((await service.work()), 0);
  assert.equal((await total(f.db, 'locations')), 1); assert.equal((await total(f.db, 'notifications')), 0); assert.equal((await total(f.db, 'safety_events')), 0);
  assert.equal((await f.db.get('SELECT count FROM geofence_states'))!.count, 1);
  assert.equal((await f.db.get('SELECT process_status FROM device_events WHERE event_id=?', second.event_id))!.process_status, 'retry');
  f.advance(2000); assert.equal((await service.work()), 1);
  assert.equal((await total(f.db, 'locations')), 2); assert.equal((await total(f.db, 'notifications')), 1); assert.equal((await total(f.db, 'safety_events')), 1);
  assert.equal((await f.db.get('SELECT attempts FROM device_events WHERE event_id=?', second.event_id))!.attempts, 1);
  assert.equal((await service.work()), 0);
});

test('durable inbox survives reopening and independent workers process arrival order once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'doogy-telemetry-')), path = join(directory, 'queue.db');
  const f = (await fixture(path));
  await f.fence();
  await f.telemetry.ingest(f.location(0.003, { event_id: 'zzzzzzzz-old', device_ts: '2026-11-17T02:00:00Z' }), f.device.device_token);
  await f.telemetry.ingest(f.location(0.003, { event_id: 'aaaaaaaa-new', device_ts: '2026-11-17T02:00:01Z' }), f.device.device_token);
  f.advance(2000); await f.db.close();
  const first = new Db(path, f.clock), second = new Db(path, f.clock);
  try {
    const worker1 = new TelemetryService(first, new DevicesService(first), new NotificationService(first));
    const worker2 = new TelemetryService(second, new DevicesService(second), new NotificationService(second));
    assert.equal((await worker1.work(1)), 1); assert.equal((await worker2.work(2)), 1);
    assert.equal((await worker1.work()), 0); assert.equal((await worker2.work()), 0);
    assert.equal((await total(first, 'locations')), 2); assert.equal((await total(first, 'safety_events')), 1);
    assert.equal((await first.get("SELECT COUNT(*) n FROM device_events WHERE process_status='processed'"))!.n, 2);
  } finally {
    await first.close(); await second.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'doogy-telemetry-')));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('out-of-order points preserve newest state and history cursor pages contain every point once', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close())); f.advance(120_000);
  const newest = f.location(0); newest.payload.battery_pct = 90;
  const old = f.location(0, { device_ts: '2026-11-17T02:00:00Z' }); old.payload.battery_pct = 10;
  const middle = f.location(0, { device_ts: '2026-11-17T02:01:00Z' });
  for (const event of [newest, old, middle]) await f.telemetry.ingest(event, f.device.device_token);
  await f.telemetry.work();
  assert.equal(((await f.telemetry.latest(f.owner.user.id, f.pet.id)) as Row).event_id, newest.event_id);
  assert.equal((await f.devices.status(f.device.device_id)).battery_pct, 90);
  assert.equal((await total(f.db, 'safety_events')), 0);
  const seen: string[] = []; let cursor: string | null = null;
  do {
    const page = (await f.telemetry.locations(f.owner.user.id, f.pet.id, { limit: 1, ...(cursor ? { cursor } : {}) }));
    seen.push(...page.items.map(r => (r as Row).event_id)); cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, [newest.event_id, middle.event_id, old.event_id]);
  await assert.rejects(async () => (await f.telemetry.locations(f.owner.user.id, f.pet.id, { cursor: 'missing-cursor' })), status(400));
});

test('binding codes expire, lock after five wrong attempts and household caregiver cannot unbind ownership', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const pet2 = (await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'second' }));
  const locked = (await provisionDevice(f.db, { serial_no: 'locked' }));
  for (let i = 0; i < 5; i++) await assert.rejects(async () => (await f.devices.claim(f.owner.user.id, { ...locked, pet_id: pet2.id, claim_code: 'incorrect' })), status(400));
  await assert.rejects(async () => (await f.devices.claim(f.owner.user.id, { ...locked, pet_id: pet2.id })), status(429));
  const expired = (await provisionDevice(f.db, { serial_no: 'expired' }));
  f.advance(31 * 60_000);
  await assert.rejects(async () => (await f.devices.claim(f.owner.user.id, { ...expired, pet_id: pet2.id })), status(400));
  const caregiver = (await f.identity.register({ email: 'caregiver@example.com', password: 'password123' }));
  const invite = (await f.identity.invite(f.owner.user.id, f.owner.household.id, { email: caregiver.user.email, role: 'caregiver' }));
  await f.identity.accept(caregiver.user.id, invite.token);
  await assert.rejects(async () => (await f.devices.unbind(caregiver.user.id, f.device.device_id)), status(404));
  await assert.rejects(async () => (await f.devices.release(f.owner.user.id, f.device.device_id)), status(409));
  const unbound = (await f.devices.unbind(f.owner.user.id, f.device.device_id));
  await assert.rejects(async () => (await f.devices.claim(caregiver.user.id, { ...unbound, pet_id: pet2.id })), status(403));
});

test('removed household caregiver retains ability to detach their own device and fence state resets', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close())); await f.fence();
  const caregiver = (await f.identity.register({ email: 'device-owner@example.com', password: 'password123' }));
  const invite = (await f.identity.invite(f.owner.user.id, f.owner.household.id, { email: caregiver.user.email, role: 'caregiver' }));
  await f.identity.accept(caregiver.user.id, invite.token);
  const claim = (await f.devices.unbind(f.owner.user.id, f.device.device_id));
  await f.devices.release(f.owner.user.id, f.device.device_id);
  await f.devices.claim(caregiver.user.id, { ...claim, pet_id: f.pet.id });
  f.advance(1000); await f.telemetry.ingest(f.location(), f.device.device_token); await f.telemetry.work();
  f.advance(1000); await f.telemetry.ingest(f.location(), f.device.device_token); await f.telemetry.work();
  assert.equal((await f.db.get('SELECT status FROM geofence_states'))!.status, 'outside');
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id);
  await assert.rejects(async () => (await f.devices.detail(caregiver.user.id, f.device.device_id)), status(404));
  const detached = (await f.devices.unbind(caregiver.user.id, f.device.device_id));
  assert.ok(detached.claim_code);
  assert.equal((await f.db.get('SELECT status FROM geofence_states'))!.status, 'unknown');
  assert.equal((await f.db.get("SELECT COUNT(*) n FROM safety_events WHERE status='open'"))!.n, 0);
  assert.equal((await f.telemetry.latest(f.owner.user.id, f.pet.id)), null);
  await f.devices.release(caregiver.user.id, f.device.device_id);
  assert.equal((await f.devices.claim(f.owner.user.id, { ...detached, pet_id: f.pet.id })).pet_id, f.pet.id);
});
