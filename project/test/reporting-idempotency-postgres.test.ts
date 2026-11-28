import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { DevicesService, provisionDevice } from '../src/devices';
import { ReportingService } from '../src/reporting';
import { dropFixtureDatabase } from './backend-fixture';

const configured = process.env.TEST_DATABASE_URL;
const status = (code: number, errorCode?: string) => (error: any) => error.getStatus?.() === code
  && (!errorCode || error.getResponse().code === errorCode);

async function fixture(work: (f: { dbs: Db[]; admin: Pool; name: string; advance: (ms: number) => void }) => Promise<void>) {
  process.env.DATA_MODE = 'offline'; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-17T06:00:00Z'), created = false;
  const admin = new Pool({ connectionString: configured });
  const name = `doogy_concurrency_test_${randomUUID().replace(/-/g, '')}`, url = new URL(configured!);
  url.pathname = `/${name}`;
  const dbs: Db[] = [];
  try {
    assert.match(name, /^doogy_concurrency_test_[a-f0-9]{32}$/);
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    for (let index = 0; index < 4; index++) dbs.push(await Db.open({ driver: 'postgres', url: url.toString(), clock: () => new Date(now) }));
    await work({ dbs, admin, name, advance: ms => { now += ms; } });
  } finally {
    try { await Promise.all(dbs.map(db => db.close())); }
    finally { try { if (created) await dropFixtureDatabase(admin, name); } finally { await admin.end(); } }
  }
}
async function seed(db: Db) {
  const identity = new IdentityService(db), password = 'Synthetic-idempotency-pg-2026';
  const owner = await identity.register({ email: 'reporting-idem-owner@example.invalid', password });
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Idempotency PG pet' });
  const device = await provisionDevice(db, { serial_no: 'IDEMPOTENCY-PG' }), devices = new DevicesService(db);
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  return { identity, owner, pet, device, devices, password };
}

test('PostgreSQL设备幂等：四连接24次策略只提交一次，TTL等号清理与新请求竞态不重复提交', { skip: !configured, timeout: 45_000 }, async () => {
  await fixture(async ({ dbs, advance }) => {
    const f = await seed(dbs[0]), services = dbs.map(db => new ReportingService(db));
    const input = { mode: 'home_idle', interval_seconds: 600, expires_in_seconds: 300 };
    const first = await Promise.all(Array.from({ length: 24 }, (_, index) => services[index % 4].setPolicy(f.owner.user.id, f.device.device_id, input, 'concurrent-policy')));
    for (const row of first) assert.deepEqual(row, first[0]);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM device_commands'))!.n, 1);
    assert.equal((await dbs[0].get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='device.policy_requested'"))!.n, 1);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n, 1);
    await assert.rejects(services[3].setPolicy(f.owner.user.id, f.device.device_id, { ...input, interval_seconds: 900 }, 'concurrent-policy'), status(409, 'IDEMPOTENCY_CONFLICT'));
    advance(24 * 3600000);
    const requests = Array.from({ length: 24 }, (_, index) => services[index % 4].setPolicy(f.owner.user.id, f.device.device_id, input, 'concurrent-policy'));
    const [next] = await Promise.all([Promise.all(requests), Promise.all(dbs.map(db => db.expireIdempotency()))]);
    for (const row of next) assert.deepEqual(row, next[0]);
    assert.notEqual(next[0].command_id, first[0].command_id);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM device_commands'))!.n, 2);
    assert.equal((await dbs[0].get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='device.policy_requested'"))!.n, 2);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n, 1);
    assert.equal((await dbs[0].get('SELECT created_at FROM idempotency_keys'))!.created_at, dbs[0].now());
    await assert.rejects(dbs[0].idempotent(f.owner.user.id, 'test/failed-transaction', 'failed', {}, async () => {
      await dbs[0].audit(f.owner.user.id, 'idempotency.synthetic_rollback', f.device.device_id);
      throw new Error('synthetic transaction failure');
    }), /synthetic transaction failure/);
    assert.equal((await dbs[0].get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='idempotency.synthetic_rollback'"))!.n, 0);
    assert.equal((await dbs[0].get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key='failed'"))!.n, 0);
  });
});

test('PostgreSQL走失幂等：会话到期与旧关闭重放、排队撤权、重绑冲突及TTL清理遵循当前授权', { skip: !configured, timeout: 45_000 }, async () => {
  await fixture(async ({ dbs, admin, name, advance }) => {
    const f = await seed(dbs[0]), services = dbs.map(db => new ReportingService(db));
    const start = { enabled: true, expires_in_seconds: 60 };
    const replies = await Promise.all(Array.from({ length: 24 }, (_, index) => services[index % 4].lostMode(f.owner.user.id, f.device.device_id, start, 'concurrent-lost')));
    for (const row of replies) assert.deepEqual(row, replies[0]);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM lost_mode_sessions'))!.n, 1);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM device_commands'))!.n, 1);
    assert.equal((await dbs[0].get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='device.lost_mode_started'"))!.n, 1);
    advance(61000);
    assert.deepEqual(await services[1].lostMode(f.owner.user.id, f.device.device_id, start, 'concurrent-lost'), replies[0]);
    assert.equal((await services[0].view(f.owner.user.id, f.device.device_id)).lost_mode.enabled, false);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM lost_mode_sessions'))!.n, 1);
    await services[0].lostMode(f.owner.user.id, f.device.device_id, { enabled: false }, 'old-stop');
    const active = await services[0].lostMode(f.owner.user.id, f.device.device_id, start, 'next-lost');
    await services[1].lostMode(f.owner.user.id, f.device.device_id, { enabled: false }, 'old-stop');
    assert.equal((await services[0].view(f.owner.user.id, f.device.device_id)).lost_mode.session!.id, active.lost_mode.session!.id);
    const member = await f.identity.register({ email: 'reporting-idem-member@example.invalid', password: f.password });
    const invite = await f.identity.invite(f.owner.user.id, f.owner.household.id, { email: member.user.email, role: 'caregiver' });
    await f.identity.accept(member.user.id, invite.token);
    await services[0].lostMode(member.user.id, f.device.device_id, start, 'before-revoke');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
    const revoking = dbs[0].transaction(async () => {
      await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, member.user.id); entered(); await gate;
    });
    await started;
    const replay = assert.rejects(services[1].lostMode(member.user.id, f.device.device_id, start, 'before-revoke'), status(404));
    const fresh = assert.rejects(services[2].lostMode(member.user.id, f.device.device_id, start, 'after-revoke'), status(404));
    try {
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (waiting < 2 && Date.now() < deadline) {
        waiting = Number((await admin.query(`SELECT COUNT(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE l.locktype='advisory' AND NOT l.granted AND a.datname=$1`, [name])).rows[0].n);
        if (waiting < 2) await new Promise(done => setTimeout(done, 20));
      }
      assert.equal(waiting, 2);
    } finally { release(); }
    await Promise.all([revoking, replay, fresh]);
    assert.equal((await dbs[0].get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key='after-revoke'"))!.n, 0);
    const renewal = await f.devices.unbind(f.owner.user.id, f.device.device_id);
    await f.devices.claim(f.owner.user.id, { ...renewal, pet_id: f.pet.id });
    const binding = (await dbs[0].get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', f.device.device_id))!.id;
    await assert.rejects(services[1].lostMode(f.owner.user.id, f.device.device_id, start, 'concurrent-lost'), status(409, 'IDEMPOTENCY_CONFLICT'));
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM lost_mode_sessions WHERE ended_at IS NULL'))!.n, 0);
    const commands = (await dbs[0].get('SELECT COUNT(*) AS n FROM device_commands'))!.n;
    advance(24 * 3600000);
    await Promise.all(dbs.map(db => db.expireIdempotency()));
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n, 0);
    assert.equal((await dbs[0].get('SELECT COUNT(*) AS n FROM device_commands'))!.n, commands);
    const next = await services[3].lostMode(f.owner.user.id, f.device.device_id, start, 'concurrent-lost');
    assert.notEqual(next.lost_mode.session!.id, replies[0].lost_mode.session!.id);
    assert.equal((await dbs[0].get('SELECT binding_id FROM lost_mode_sessions WHERE id=?', next.lost_mode.session!.id))!.binding_id, binding);
  });
});
