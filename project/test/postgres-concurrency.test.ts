import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { DevicesService, provisionDevice } from '../src/devices';
import { FencesService } from '../src/fences';
import { TelemetryService } from '../src/telemetry';
import { NotificationService } from '../src/notifications';
import { dropFixtureDatabase } from './backend-fixture';

const configured = process.env.TEST_DATABASE_URL;
const clock = () => new Date('2026-11-17T06:00:00Z');
const status = (code: number) => (error: any) => error.getStatus?.() === code;

async function fixture(work: (dbs: Db[], admin: Pool, name: string) => Promise<void>) {
  const admin = new Pool({ connectionString: configured });
  const name = `doogy_concurrency_test_${randomUUID().replace(/-/g, '')}`;
  const url = new URL(configured!); url.pathname = `/${name}`;
  const dbs: Db[] = [];
  let created = false;
  try {
    process.env.DATA_MODE = 'offline';
    assert.match(name, /^doogy_concurrency_test_[a-f0-9]{32}$/);
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    for (let i = 0; i < 4; i++) dbs.push(await Db.open({ driver: 'postgres', url: url.toString(), clock }));
    await work(dbs, admin, name);
  } finally {
    try { await Promise.all(dbs.map(db => db.close())); }
    finally {
      try {
        if (created) {
          await dropFixtureDatabase(admin, name);
        }
      }
      finally { await admin.end(); }
    }
  }
}

async function account(db: Db, email = 'concurrent-owner@example.invalid') {
  return new IdentityService(db).register({ email, password: 'Synthetic-concurrency-2026' });
}

test('PostgreSQL并发：四个独立连接同时重放创建只提交一个宠物、审计和幂等响应', { skip: !configured, timeout: 30_000 }, async () => {
  await fixture(async dbs => {
    const owner = await account(dbs[0]);
    const input = { household_id: owner.household.id, name: '并发合成宠物', timezone: 'UTC' };
    const identities = dbs.map(db => new IdentityService(db));
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => identities[index % 4].createPet(owner.user.id, input, 'concurrent-create')));
    assert.equal(new Set(results.map(row => row.id)).size, 1);
    for (const row of results) assert.deepEqual(row, results[0]);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM pets'))!.n, 1);
    assert.equal((await dbs[0].get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='pet.create'"))!.n, 1);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n, 1);
    await assert.rejects(identities[3].createPet(owner.user.id, { ...input, name: '异内容' }, 'concurrent-create'), status(409));
  });
});

test('PostgreSQL并发：重复和乱序上报由四个Worker仅投影一次，最新状态不倒退且通知不重复', { skip: !configured, timeout: 30_000 }, async () => {
  await fixture(async dbs => {
    const db = dbs[0], owner = await account(db), identity = new IdentityService(db);
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '多Worker合成宠物' });
    const device = await provisionDevice(db, { serial_no: `CONCURRENT-${randomUUID()}` });
    await new DevicesService(db).claim(owner.user.id, { ...device, pet_id: pet.id });
    const fence = await new FencesService(db).create(owner.user.id, { pet_id: pet.id, name: '并发围栏',
      geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
    const notifications = dbs.map(connection => new NotificationService(connection));
    const workers = dbs.map((connection, index) => new TelemetryService(connection, new DevicesService(connection), notifications[index]));
    let seq = 0;
    const event = (seconds: number, lat = 31.232) => ({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
      boot_id: 'concurrent-boot', seq: seq++, device_ts: new Date(clock().getTime() + seconds * 1000).toISOString(),
      event_type: 'location.reported', payload: { lat, lon: 121.47, accuracy_m: 10, source: 'gnss', battery_pct: 15 } });
    const inside = event(-200, 31.23), first = event(-180), second = event(-160), newest = event(-5);
    await workers[0].ingest(inside, device.device_token); await workers[1].work();
    await workers[0].ingest(first, device.device_token); await workers[1].ingest(second, device.device_token);
    assert.equal((await Promise.all(workers.map(worker => worker.work()))).reduce((sum, count) => sum + count, 0), 2);
    await workers[2].ingest(newest, device.device_token); await workers[3].work();
    const older = Array.from({ length: 12 }, (_, index) => event(-150 + index * 10));
    const packets = [...older, newest, first].flatMap(packet => [packet, packet, packet]);
    const accepting = Promise.all(packets.map((packet, index) => workers[index % 4].ingest(packet, device.device_token)));
    const consuming = Promise.all(workers.map(worker => worker.work()));
    const accepted = await accepting;
    await consuming;
    await Promise.all(workers.map(worker => worker.work()));
    assert.equal(accepted.filter(row => !row.duplicate).length, older.length);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM device_events'))!.n, 16);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM locations'))!.n, 16);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM device_events WHERE process_status<>'processed' OR attempts<>0"))!.n, 0);
    assert.equal((await workers[0].latest(owner.user.id, pet.id))!.event_id, newest.event_id);
    assert.equal((await db.get('SELECT reported_at FROM device_state WHERE device_id=?', device.device_id))!.reported_at, newest.device_ts);
    assert.equal((await db.get('SELECT status,last_ts FROM geofence_states WHERE fence_id=?', fence.id))!.last_ts, newest.device_ts);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM safety_events WHERE type='geofence.exited'"))!.n, 1);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM safety_events WHERE type='battery.low'"))!.n, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM notifications'))!.n, 2);
    const dispatched = await Promise.all(notifications.map(service => service.dispatch()));
    assert.equal(dispatched.reduce((sum, count) => sum + count, 0), 2);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM notifications WHERE status='simulated' AND provider_message_id IS NOT NULL AND lease_until IS NULL"))!.n, 2);
  });
});

test('PostgreSQL并发：撤权事务先提交后，排队的创建和旧幂等响应均不能越过权限检查', { skip: !configured, timeout: 30_000 }, async () => {
  await fixture(async (dbs, admin, name) => {
    const identity = new IdentityService(dbs[0]), owner = await account(dbs[0]);
    const member = await account(dbs[0], 'concurrent-caregiver@example.invalid');
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: member.user.email, role: 'caregiver' });
    await identity.accept(member.user.id, invitation.token);
    const input = { household_id: owner.household.id, name: '撤权前创建' };
    const first = await identity.createPet(member.user.id, input, 'before-revoke');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { release = done; });
    const revoking = dbs[0].transaction(async () => {
      await identity.revokeMember(owner.user.id, owner.household.id, member.user.id);
      entered(); await gate;
    });
    await started;
    const replay = assert.rejects(new IdentityService(dbs[1]).createPet(member.user.id, input, 'before-revoke'), status(404));
    const creating = assert.rejects(new IdentityService(dbs[2]).createPet(member.user.id, { ...input, name: '撤权后排队创建' }, 'after-revoke'), status(404));
    try {
      // Wait for real PostgreSQL lock waiters rather than depending on promise scheduling.
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (waiting < 2 && Date.now() < deadline) {
        waiting = Number((await admin.query(`SELECT COUNT(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE l.locktype='advisory' AND NOT l.granted AND a.datname=$1`, [name])).rows[0].n);
        if (waiting < 2) await new Promise(done => setTimeout(done, 20));
      }
      assert.equal(waiting, 2);
    } finally { release(); }
    await Promise.all([revoking, replay, creating]);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM pets'))!.n, 1);
    assert.equal((await dbs[0].get('SELECT id FROM pets'))!.id, first.id);
    assert.equal((await dbs[0].get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='pet.create'"))!.n, 1);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n, 1);
  });
});
