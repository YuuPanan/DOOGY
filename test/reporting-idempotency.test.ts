import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db, Row } from '../src/db';
import { DevicesService, provisionDevice } from '../src/devices';
import { IdentityService } from '../src/identity';
import { PrivacyService } from '../src/privacy';
import { ReportingService } from '../src/reporting';
import { privacyMaintenance } from '../scripts/privacy-maintenance';

const password = 'Synthetic-command-idempotency-2026', hour = 3600000;
const policy = { mode: 'home_idle', interval_seconds: 600 };
const status = (code: number, errorCode?: string) => (error: unknown) => error instanceof HttpException && error.getStatus() === code
  && (!errorCode || (error.getResponse() as Row).code === errorCode);
beforeEach(() => { process.env.DATA_MODE = 'offline'; process.env.IDEMPOTENCY_TTL_HOURS = '24'; });

async function fixture() {
  let now = Date.parse('2026-11-17T06:00:00Z');
  const db = new Db(':memory:', () => new Date(now)), identity = new IdentityService(db);
  const owner = await identity.register({ email: 'command-owner@example.invalid', password });
  const member = await identity.register({ email: 'command-member@example.invalid', password });
  const invitation = await identity.invite(owner.user.id, owner.household.id, { email: member.user.email, role: 'caregiver' });
  await identity.accept(member.user.id, invitation.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Command retry pet' });
  const device = await provisionDevice(db, { serial_no: 'COMMAND-IDEMPOTENCY' }), devices = new DevicesService(db);
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  return { db, identity, owner, member, pet, device, devices, reporting: new ReportingService(db), advance: (ms: number) => { now += ms; } };
}
const commands = async (db: Db) => (await db.get('SELECT COUNT(*) AS n FROM device_commands'))!.n;
const audits = async (db: Db, action: string) => (await db.get('SELECT COUNT(*) AS n FROM audit_logs WHERE action=?', action))!.n;

test('策略幂等按规范化输入重放首次回执，不重复命令/审计，也不刷新缓存时间', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'policy-request');
  const saved = await f.db.get('SELECT * FROM idempotency_keys WHERE key=?', 'policy-request');
  f.advance(1000);
  await f.reporting.acknowledge(f.device.device_id, first.command_id, f.device.device_token, { status: 'applied', applied_version: first.desired_version });
  assert.deepEqual(await f.reporting.setPolicy(f.owner.user.id, f.device.device_id,
    { interval_seconds: 600, mode: 'home_idle', expires_in_seconds: 300 }, 'policy-request'), first);
  assert.equal(first.status, 'pending');
  assert.equal((await f.reporting.view(f.owner.user.id, f.device.device_id)).status, 'applied');
  assert.equal(await commands(f.db), 1); assert.equal(await audits(f.db, 'device.policy_requested'), 1);
  assert.deepEqual(await f.db.get('SELECT * FROM idempotency_keys WHERE key=?', 'policy-request'), saved);
  await assert.rejects(f.reporting.setPolicy(f.owner.user.id, f.device.device_id, { ...policy, interval_seconds: 120 }, 'policy-request'), status(409, 'IDEMPOTENCY_CONFLICT'));
  const another = await f.reporting.setPolicy(f.member.user.id, f.device.device_id, policy, 'policy-request');
  assert.notEqual(another.command_id, first.command_id);
  assert.equal(await commands(f.db), 2);
});

test('走失开启旧键在会话到期后不重开，关闭旧键也不关闭后来开启的会话', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = JSON.parse(JSON.stringify(await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true, expires_in_seconds: 60 }, 'lost-start'))) as Row;
  assert.deepEqual(await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { expires_in_seconds: 60, enabled: true }, 'lost-start'), first);
  assert.equal(await commands(f.db), 1); assert.equal(await audits(f.db, 'device.lost_mode_started'), 1);
  await assert.rejects(f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true, expires_in_seconds: 120 }, 'lost-start'), status(409));
  f.advance(61000);
  assert.deepEqual(await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true, expires_in_seconds: 60 }, 'lost-start'), first);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM lost_mode_sessions'))!.n, 1);
  assert.equal((await f.reporting.view(f.owner.user.id, f.device.device_id)).lost_mode.enabled, false);
  assert.equal(await commands(f.db), 2);
  await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true }, 'new-start');
  const closed = await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: false }, 'lost-close');
  const latest = await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true }, 'latest-start');
  const count = await commands(f.db);
  assert.deepEqual(await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: false, expires_in_seconds: 3600 }, 'lost-close'), closed);
  const current = await f.reporting.view(f.owner.user.id, f.device.device_id);
  assert.ok(current.lost_mode.session); assert.ok(latest.lost_mode.session);
  assert.equal(current.lost_mode.session.id, latest.lost_mode.session.id);
  assert.equal(await commands(f.db), count); assert.equal(await audits(f.db, 'device.lost_mode_stopped'), 1);
});

test('重放仍检查当前角色和成员权限，同一绑定所有权交接不阻断仍有写权限的原owner', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'owner-policy');
  await new PrivacyService(f.db).transferOwner(f.owner.user.id, f.owner.household.id, { password, new_owner_user_id: f.member.user.id });
  assert.deepEqual(await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'owner-policy'), first);
  await f.identity.changeMember(f.member.user.id, f.owner.household.id, f.owner.user.id, { role: 'viewer' });
  await assert.rejects(f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'owner-policy'), status(403));
  await f.identity.revokeMember(f.member.user.id, f.owner.household.id, f.owner.user.id);
  await assert.rejects(f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'owner-policy'), status(404));
  assert.equal(await commands(f.db), 1);
});

test('同一用户解绑重绑后旧策略/走失键冲突，既不返回旧回执也不执行新命令', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'old-binding-policy');
  await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true }, 'old-binding-lost');
  const old = (await f.db.get('SELECT id FROM device_bindings WHERE unbound_at IS NULL'))!.id;
  const code = await f.devices.unbind(f.owner.user.id, f.device.device_id);
  await f.devices.claim(f.owner.user.id, { ...code, pet_id: f.pet.id });
  assert.notEqual((await f.db.get('SELECT id FROM device_bindings WHERE unbound_at IS NULL'))!.id, old);
  const count = await commands(f.db);
  await assert.rejects(f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'old-binding-policy'), status(409, 'IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true }, 'old-binding-lost'), status(409, 'IDEMPOTENCY_CONFLICT'));
  assert.equal(await commands(f.db), count);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM lost_mode_sessions WHERE ended_at IS NULL'))!.n, 0);
});

test('成功策略旧键不被后来的走失状态阻断，失败策略不占用幂等键', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'before-lost');
  await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true }, 'active-lost');
  assert.deepEqual(await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'before-lost'), first);
  await assert.rejects(f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'failed-during-lost'), status(409, 'LOST_MODE_ACTIVE'));
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE key=?', 'failed-during-lost'), undefined);
  await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: false });
  assert.equal((await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'failed-during-lost')).status, 'pending');
});

test('幂等TTL精确等号到期，旧键可形成新意图；失败事务不占用新缓存也不复活过期响应', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'ttl-policy');
  f.advance(24 * hour - 1);
  assert.deepEqual(await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'ttl-policy'), first);
  f.advance(1);
  const fresh = await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, { ...policy, interval_seconds: 120 }, 'ttl-policy');
  assert.notEqual(fresh.command_id, first.command_id);
  assert.equal((await f.db.get('SELECT created_at FROM idempotency_keys WHERE key=?', 'ttl-policy'))!.created_at, f.db.now());
  const original = await f.db.idempotent(f.owner.user.id, 'ttl-rollback', 'retry', { revision: 1 }, () => ({ response: 'old' }));
  f.advance(24 * hour);
  await assert.rejects(f.db.idempotent(f.owner.user.id, 'ttl-rollback', 'retry', { revision: 2 }, async () => {
    await f.db.audit(null, 'test.idempotency.rollback', f.device.device_id); throw new Error('Synthetic expired work failure');
  }), /Synthetic expired work failure/);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='test.idempotency.rollback'"))!.n, 0);
  const current = await f.db.idempotent(f.owner.user.id, 'ttl-rollback', 'retry', { revision: 2 }, () => ({ response: 'new' }));
  assert.notDeepEqual(current, original); assert.equal(current.response, 'new');
});

test('幂等维护按配置期限零写预览，仅删除到期记录，CLI不返回请求或响应正文', async t => {
  const f = await fixture(); t.after(() => f.db.close()); process.env.IDEMPOTENCY_TTL_HOURS = '1';
  await f.db.idempotent(f.owner.user.id, 'maintenance-old', 'old-key-private', { private: 'private-request-body' }, () => ({ private: 'private-response-body' }));
  f.advance(hour);
  await f.db.idempotent(f.member.user.id, 'maintenance-current', 'current-key-private', {}, () => ({ value: 'keep' }));
  const before = await f.db.all('SELECT * FROM idempotency_keys ORDER BY scope');
  const preview = await f.db.expireIdempotency(true);
  assert.equal(preview.retention_hours, 1); assert.equal(preview.matched_records, 1); assert.equal(preview.deleted_records, 0);
  assert.deepEqual(await f.db.all('SELECT * FROM idempotency_keys ORDER BY scope'), before);
  const cliPreview = await privacyMaintenance(f.db, 'idempotency-preview'); assert.deepEqual(cliPreview, preview);
  const clean = await privacyMaintenance(f.db, 'idempotency-clean'); assert.equal(clean.deleted_records, 1);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n, 1);
  assert.equal((await f.db.get('SELECT key FROM idempotency_keys'))!.key, 'current-key-private');
  const encoded = JSON.stringify({ preview, clean });
  for (const value of ['private-request-body','private-response-body','old-key-private','current-key-private']) assert.ok(!encoded.includes(value));
  assert.equal((await f.db.expireIdempotency()).deleted_records, 0);
});

test('维护等待期间撤权，策略与走失旧键均重新校验当前成员权限', async () => {
  for (const operation of ['policy','lost']) {
    const f = await fixture();
    try {
      if (operation === 'policy') await f.reporting.setPolicy(f.member.user.id, f.device.device_id, policy, 'revoked-key');
      else await f.reporting.lostMode(f.member.user.id, f.device.device_id, { enabled: true }, 'revoked-key');
      class RevokedReporting extends ReportingService {
        override async expire() { await super.expire(); await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.member.user.id); }
      }
      const reporting = new RevokedReporting(f.db), before = await commands(f.db);
      await assert.rejects(operation === 'policy'
        ? reporting.setPolicy(f.member.user.id, f.device.device_id, policy, 'revoked-key')
        : reporting.lostMode(f.member.user.id, f.device.device_id, { enabled: true }, 'revoked-key'), status(404));
      assert.equal(await commands(f.db), before);
    } finally { await f.db.close(); }
  }
});
