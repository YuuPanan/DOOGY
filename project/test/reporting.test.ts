import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test, beforeEach } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { DevicesService, provisionDevice } from '../src/devices';
import { IdentityService } from '../src/identity';
import { deviceTiming, ReportingService } from '../src/reporting';
import { simulateDevice } from '../scripts/simulate-device';

beforeEach(() => {
  process.env.DATA_MODE = 'offline'; process.env.FRESH_SECONDS = '300'; process.env.OFFLINE_SECONDS = '300';
});
const hasStatus = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
async function fixture() {
  let time = Date.parse('2026-11-17T02:00:00Z');
  const db = new Db(':memory:', () => new Date(time)), identity = new IdentityService(db);
  const account = (await identity.register({ email: 'reporting@example.invalid', password: 'Synthetic-password-2026' }));
  const pet = (await identity.createPet(account.user.id, { household_id: account.household.id, name: 'Reporting dog' }));
  const device = (await provisionDevice(db, { serial_no: 'REPORTING-DEVICE' })), devices = new DevicesService(db);
  await devices.claim(account.user.id, { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
  return { db, identity, account, pet, device, devices, reporting: new ReportingService(db), advance: (ms: number) => { time += ms; } };
}

test('策略请求持久为pending，显式模拟回执后才改变应用版本和TTL', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const requested = (await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 }));
  assert.equal(requested.status, 'pending'); assert.equal(requested.applied, null);
  assert.equal((await deviceTiming(f.db, f.device.device_id)).offline_seconds, 300);
  const commands = (await f.reporting.poll(f.device.device_id, f.device.device_token)).items;
  assert.equal(commands.length, 1);
  assert.equal((await f.reporting.view(f.account.user.id, f.device.device_id)).applied, null);
  const receipt = (await simulateDevice(f.db, f.device.device_id, f.device.device_token))[0];
  assert.equal(receipt.status, 'applied'); assert.equal(receipt.execution_source, 'simulator');
  assert.equal((await f.reporting.view(f.account.user.id, f.device.device_id)).applied_version, requested.desired_version);
  assert.equal((await deviceTiming(f.db, f.device.device_id)).offline_seconds, 1800);
  assert.equal((await deviceTiming(f.db, f.device.device_id)).fresh_seconds, 1800);
  await f.db.run('UPDATE device_state SET last_seen_at=? WHERE device_id=?', f.db.now(), f.device.device_id);
  f.advance(600_000);
  assert.equal((await f.devices.status(f.device.device_id)).connection_status, 'online');
});

test('新意图替换旧命令，错误版本和旧命令回执不能覆盖当前策略', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const first = (await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 }));
  const second = (await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'alert', interval_seconds: 15 }));
  assert.equal((await f.reporting.command(f.account.user.id, f.device.device_id, first.command_id)).status, 'superseded');
  await assert.rejects(async () => (await f.reporting.acknowledge(f.device.device_id, first.command_id, f.device.device_token, { status: 'applied', applied_version: first.desired_version })), hasStatus(409));
  await assert.rejects(async () => (await f.reporting.acknowledge(f.device.device_id, second.command_id, f.device.device_token, { status: 'applied', applied_version: 999 })), hasStatus(409));
  const receipt = (await f.reporting.acknowledge(f.device.device_id, second.command_id, f.device.device_token, { status: 'applied', applied_version: second.desired_version }));
  assert.equal(receipt.policy.mode, 'alert');
  assert.deepEqual((await f.reporting.acknowledge(f.device.device_id, second.command_id, f.device.device_token, { status: 'applied', applied_version: second.desired_version })), receipt);
  await assert.rejects(async () => (await f.reporting.acknowledge(f.device.device_id, second.command_id, f.device.device_token, { status: 'failed', applied_version: second.desired_version })), hasStatus(409));
});

test('设备token、跨家庭、只读成员权限均检查，API回执区分真实设备来源', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const visitor = (await f.identity.register({ email: 'other-reporting@example.invalid', password: 'Synthetic-password-2026' }));
  await assert.rejects(async () => (await f.reporting.view(visitor.user.id, f.device.device_id)), hasStatus(404));
  const invitation = (await f.identity.invite(f.account.user.id, f.account.household.id, { email: visitor.user.email, role: 'viewer' }));
  await f.identity.accept(visitor.user.id, invitation.token);
  await assert.rejects(async () => (await f.reporting.setPolicy(visitor.user.id, f.device.device_id, { mode: 'alert', interval_seconds: 15 })), hasStatus(403));
  await assert.rejects(async () => (await f.reporting.poll(f.device.device_id, 'incorrect')), hasStatus(401));
  const request = (await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'alert', interval_seconds: 15 }));
  await assert.rejects(async () => (await f.reporting.acknowledge(f.device.device_id, request.command_id, 'incorrect', { status: 'applied', applied_version: request.desired_version })), hasStatus(401));
  process.env.DATA_MODE = 'api';
  await assert.rejects(async () => (await simulateDevice(f.db, f.device.device_id, f.device.device_token)), /offline/);
  const result = (await f.reporting.acknowledge(f.device.device_id, request.command_id, f.device.device_token, { status: 'applied', applied_version: request.desired_version }));
  assert.equal(result.execution_source, 'device');
});

test('未回执命令到期与失败均不虚构应用成功', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const request = (await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600, expires_in_seconds: 30 }));
  f.advance(31_000); await f.reporting.expire();
  assert.equal((await f.reporting.view(f.account.user.id, f.device.device_id)).status, 'expired');
  assert.equal((await f.reporting.poll(f.device.device_id, f.device.device_token)).items.length, 0);
  await assert.rejects(async () => (await f.reporting.acknowledge(f.device.device_id, request.command_id, f.device.device_token, { status: 'applied', applied_version: request.desired_version })), hasStatus(409));
  const next = (await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 }));
  await f.reporting.acknowledge(f.device.device_id, next.command_id, f.device.device_token, { status: 'failed', applied_version: next.desired_version, error: 'LOW_POWER' });
  assert.equal((await f.reporting.view(f.account.user.id, f.device.device_id)).status, 'failed');
  assert.equal((await deviceTiming(f.db, f.device.device_id)).source, 'default');
});

test('走失模式开启请求和关闭恢复均等待回执，超时自动请求恢复原策略', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 });
  await simulateDevice(f.db, f.device.device_id, f.device.device_token);
  const lost = (await f.reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: true, expires_in_seconds: 60 }));
  assert.equal(lost.desired.mode, 'alert'); assert.equal(lost.applied.mode, 'home_idle'); assert.equal(lost.status, 'pending');
  assert.equal((await f.reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: true })).command_id, lost.command_id);
  await assert.rejects(async () => (await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 })), hasStatus(409));
  await simulateDevice(f.db, f.device.device_id, f.device.device_token);
  f.advance(61_000); await f.reporting.expire();
  const restored = (await f.reporting.view(f.account.user.id, f.device.device_id));
  assert.equal(restored.lost_mode.enabled, false); assert.equal(restored.desired.mode, 'home_idle');
  assert.equal(restored.applied.mode, 'alert'); assert.equal(restored.status, 'pending');
  await simulateDevice(f.db, f.device.device_id, f.device.device_token);
  assert.equal((await f.reporting.view(f.account.user.id, f.device.device_id)).applied.mode, 'home_idle');
  await f.reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: true });
  const stopped = (await f.reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: false }));
  assert.equal(stopped.desired.mode, 'home_idle'); assert.equal(stopped.status, 'pending');
});

test('解绑取消命令和走失会话，换绑不能执行旧命令，旧策略不影响TTL', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const request = (await f.reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: true }));
  const unbound = (await f.devices.unbind(f.account.user.id, f.device.device_id));
  assert.equal((await f.db.get('SELECT status FROM device_commands WHERE id=?', request.command_id))!.status, 'cancelled');
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM reporting_policies'))!.n, 0);
  await f.devices.claim(f.account.user.id, { device_id: f.device.device_id, pet_id: f.pet.id, claim_code: unbound.claim_code });
  await assert.rejects(async () => (await f.reporting.acknowledge(f.device.device_id, request.command_id, f.device.device_token, { status: 'applied', applied_version: request.desired_version })), hasStatus(404));
  assert.equal((await f.reporting.poll(f.device.device_id, f.device.device_token)).items.length, 0);
  assert.equal((await deviceTiming(f.db, f.device.device_id)).source, 'default');
  const next = (await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_active', interval_seconds: 120 }));
  assert.ok(next.desired_version > request.desired_version);
});

test('所有者可在解绑后重新签发过期或锁定绑定码，旧码失效', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  await assert.rejects(async () => (await f.devices.renewClaimCode(f.account.user.id, f.device.device_id)), hasStatus(409));
  const unbound = (await f.devices.unbind(f.account.user.id, f.device.device_id));
  await f.db.run('UPDATE devices SET claim_attempts=5,claim_expires_at=? WHERE id=?', '2020-01-01T00:00:00.000Z', f.device.device_id);
  const renewed = (await f.devices.renewClaimCode(f.account.user.id, f.device.device_id));
  await assert.rejects(async () => (await f.devices.claim(f.account.user.id, { device_id: f.device.device_id, pet_id: f.pet.id, claim_code: unbound.claim_code })), hasStatus(400));
  assert.equal((await f.devices.claim(f.account.user.id, { device_id: f.device.device_id, pet_id: f.pet.id, claim_code: renewed.claim_code })).id, f.device.device_id);
});

test('Worker暂停时到期走失会话也拒绝迟到升频回执，可直接重新开启会话', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  const first = (await f.reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: true, expires_in_seconds: 60 }));
  const sessionId = first.lost_mode.session!.id;
  f.advance(61_000);
  await assert.rejects(async () => (await f.reporting.acknowledge(f.device.device_id, first.command_id, f.device.device_token,
    { status: 'applied', applied_version: first.desired_version })), hasStatus(409));
  assert.equal((await f.reporting.view(f.account.user.id, f.device.device_id)).desired.mode, 'home_active');
  const second = (await f.reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: true, expires_in_seconds: 60 }));
  assert.notEqual(second.lost_mode.session!.id, sessionId);
  assert.ok(second.desired_version > first.desired_version);
  assert.equal(second.status, 'pending');
});

test('走失结束恢复最近的普通策略意图，即使该普通策略此前尚未回执', async t => {
  const f = (await fixture()); t.after(async () => (await f.db.close()));
  await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 });
  await simulateDevice(f.db, f.device.device_id, f.device.device_token);
  await f.reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_active', interval_seconds: 120 });
  await f.reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: true });
  assert.equal((await f.reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: false })).desired.mode, 'home_active');
});

test('异步维护期间发生换绑，新的策略与走失请求只引用当前绑定', async () => {
  for (const action of ['policy', 'lost']) {
    const f = await fixture();
    try {
      const previous = (await f.db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', f.device.device_id))!.id;
      class ReboundReporting extends ReportingService {
        override async expire() {
          await super.expire();
          const code = await f.devices.unbind(f.account.user.id, f.device.device_id);
          await f.devices.claim(f.account.user.id, { ...code, pet_id: f.pet.id });
        }
      }
      const reporting = new ReboundReporting(f.db);
      if (action === 'policy') await reporting.setPolicy(f.account.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 });
      else await reporting.lostMode(f.account.user.id, f.device.device_id, { enabled: true });
      const current = (await f.db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', f.device.device_id))!.id;
      assert.notEqual(current, previous);
      assert.equal((await f.db.get('SELECT binding_id FROM reporting_policies WHERE device_id=?', f.device.device_id))!.binding_id, current);
      if (action === 'lost') assert.equal((await f.db.get('SELECT binding_id FROM lost_mode_sessions WHERE ended_at IS NULL'))!.binding_id, current);
    } finally { await f.db.close(); }
  }
});

test('异步维护期间撤销家庭权限，策略写入重新检查当前权限', async () => {
  const f = await fixture();
  try {
    const caregiver = await f.identity.register({ email: 'async-caregiver@example.invalid', password: 'Synthetic-password-2026' });
    const invitation = await f.identity.invite(f.account.user.id, f.account.household.id, { email: caregiver.user.email, role: 'caregiver' });
    await f.identity.accept(caregiver.user.id, invitation.token);
    class RevokedReporting extends ReportingService {
      override async expire() {
        await super.expire();
        await f.identity.revokeMember(f.account.user.id, f.account.household.id, caregiver.user.id);
      }
    }
    await assert.rejects(new RevokedReporting(f.db).setPolicy(caregiver.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 }), hasStatus(404));
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM device_commands'))!.n, 0);
  } finally { await f.db.close(); }
});
