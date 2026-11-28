import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { DevicesService, hash, provisionDevice } from '../src/devices';
import { DeviceCredentialsService } from '../src/device-credentials';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { ReportingService } from '../src/reporting';
import { TelemetryService } from '../src/telemetry';
import { CareService } from '../src/care';
import { OperationsService } from '../src/operations';

beforeEach(() => {
  process.env.DATA_MODE = 'offline';
  process.env.DEVICE_ADMIN_USER_IDS = '';
  process.env.SUPPORT_ADMIN_USER_IDS = '';
});
const status = (...codes: number[]) => (error: unknown) => error instanceof HttpException && codes.includes(error.getStatus());
const reason = { reason: 'Scheduled credential maintenance' };

async function fixture() {
  let time = Date.parse('2026-11-17T06:00:00Z'), seq = 0;
  const db = new Db(':memory:', () => new Date(time)), identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `${name}@example.invalid`, password: 'Synthetic-credential-2026' });
  const owner = await register('credential-owner'), caregiver = await register('credential-caregiver'), viewer = await register('credential-viewer');
  const outsider = await register('credential-outsider'), admin = await register('credential-admin');
  for (const [member, role] of [[caregiver, 'caregiver'], [viewer, 'viewer']] as const) {
    const invite = await identity.invite(owner.user.id, owner.household.id, { email: member.user.email, role });
    await identity.accept(member.user.id, invite.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Credential fixture pet' });
  const device = await provisionDevice(db, { serial_no: 'CREDENTIAL-FIXTURE' }), devices = new DevicesService(db);
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  const reporting = new ReportingService(db), credentials = new DeviceCredentialsService(db);
  const telemetry = new TelemetryService(db, devices, new NotificationService(db));
  const event = () => ({ schema_version: '1.0', event_id: `credential-event-${++seq}`, device_id: device.device_id,
    boot_id: 'credential-boot', seq, device_ts: db.now(), event_type: 'state.reported', payload: { battery_pct: 80 } });
  return { db, identity, owner, caregiver, viewer, outsider, admin, pet, device, devices, reporting, credentials, telemetry, event,
    advance: (milliseconds: number) => { time += milliseconds; } };
}

test('设备凭证从第一代active开始，轮换立即拒绝旧token并让新token执行遥测和命令', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const initial = await f.credentials.view(f.owner.user.id, f.device.device_id);
  assert.deepEqual(initial.credential, { version: 1, status: 'active', changed_at: f.db.now() });
  const command = await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 });
  const received = f.event(); await f.telemetry.ingest(received, f.device.device_token);
  f.advance(1000);
  const rotated = await f.credentials.rotate(f.owner.user.id, f.device.device_id, reason);
  assert.notEqual(rotated.device_token, f.device.device_token);
  assert.deepEqual(rotated.credential, { version: 2, status: 'active', changed_at: f.db.now() });
  await assert.rejects(f.telemetry.ingest(received, f.device.device_token), status(401));
  await assert.rejects(f.telemetry.ingest(f.event(), f.device.device_token), status(401));
  await assert.rejects(f.reporting.poll(f.device.device_id, f.device.device_token), status(401));
  await assert.rejects(f.reporting.acknowledge(f.device.device_id, command.command_id, f.device.device_token,
    { status: 'applied', applied_version: command.desired_version }), status(401));
  assert.equal((await f.telemetry.ingest(received, rotated.device_token)).duplicate, true);
  assert.equal((await f.telemetry.ingest(f.event(), rotated.device_token)).duplicate, false);
  assert.equal((await f.reporting.poll(f.device.device_id, rotated.device_token)).items.length, 1);
  assert.equal((await f.reporting.acknowledge(f.device.device_id, command.command_id, rotated.device_token,
    { status: 'applied', applied_version: command.desired_version })).status, 'applied');
});

test('吊销阻断全部设备入口及供应商入口，已持久接收消息仍由Worker完成且重复吊销不变更', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const accepted = f.event(); await f.telemetry.ingest(accepted, f.device.device_token);
  const command = await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, { mode: 'alert', interval_seconds: 15 });
  f.advance(1000);
  const revoked = await f.credentials.revoke(f.owner.user.id, f.device.device_id, reason);
  assert.deepEqual(revoked.credential, { version: 1, status: 'revoked', changed_at: f.db.now() });
  await Promise.all([f.telemetry.ingest(f.event(), f.device.device_token), f.telemetry.ingestVendor(f.event()),
    f.reporting.poll(f.device.device_id, f.device.device_token), f.reporting.acknowledge(f.device.device_id, command.command_id, f.device.device_token,
      { status: 'applied', applied_version: command.desired_version })].map(request => assert.rejects(request, status(401))));
  await assert.rejects(f.telemetry.ingestVendor(accepted), status(401));
  assert.equal(await f.telemetry.work(), 1);
  assert.equal((await f.db.get('SELECT process_status FROM device_events WHERE event_id=?', accepted.event_id))!.process_status, 'processed');
  f.advance(1000);
  assert.deepEqual(await f.credentials.revoke(f.owner.user.id, f.device.device_id, { reason: 'Already revoked, leave unchanged' }), revoked);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='device.credential.revoked'"))!.n, 1);
  const recovered = await f.credentials.rotate(f.owner.user.id, f.device.device_id, reason);
  assert.equal(recovered.credential.version, 2); assert.equal(recovered.credential.status, 'active');
  await assert.rejects(f.telemetry.ingest(f.event(), f.device.device_token), status(401));
  assert.equal((await f.telemetry.ingest(f.event(), recovered.device_token)).duplicate, false);
});

test('只有设备所有者能管理凭证，家庭共享读者只能看非敏感元数据', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  for (const member of [f.caregiver, f.viewer, f.outsider]) {
    await assert.rejects(f.credentials.view(member.user.id, f.device.device_id), status(403, 404));
    await assert.rejects(f.credentials.rotate(member.user.id, f.device.device_id, reason), status(403, 404));
    await assert.rejects(f.credentials.revoke(member.user.id, f.device.device_id, reason), status(403, 404));
  }
  const detail = await f.devices.detail(f.viewer.user.id, f.device.device_id);
  assert.equal(detail.credential.version, 1); assert.equal(detail.credential.status, 'active');
  assert.ok(!JSON.stringify(detail).includes('secret_hash'));
  await f.devices.unbind(f.owner.user.id, f.device.device_id);
  assert.equal((await f.credentials.rotate(f.owner.user.id, f.device.device_id, reason)).credential.version, 2);
  await f.devices.release(f.owner.user.id, f.device.device_id);
  await assert.rejects(f.credentials.rotate(f.owner.user.id, f.device.device_id, reason), status(403, 404));
});

test('凭证和审计不包含明文token或散列，缺失原因被拒绝且没有secret响应缓存', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await assert.rejects(f.credentials.rotate(f.owner.user.id, f.device.device_id, { reason: ' ' }));
  await assert.rejects(f.credentials.revoke(f.owner.user.id, f.device.device_id, { reason: 'x'.repeat(501) }));
  const first = await f.credentials.rotate(f.owner.user.id, f.device.device_id, { reason: '  Trim audit reason  ' });
  const second = await f.credentials.rotate(f.owner.user.id, f.device.device_id, reason);
  assert.notEqual(first.device_token, second.device_token);
  assert.equal(second.credential.version, 3);
  const audits = await f.db.all("SELECT action,metadata_json FROM audit_logs WHERE action='device.credential.rotated' ORDER BY created_at,id");
  assert.equal(audits.length, 2);
  const metadata = audits.map(row => JSON.parse(row.metadata_json));
  assert.ok(metadata.some(row => row.reason === 'Trim audit reason' && row.previous_version === 1 && row.version === 2));
  const overview = await new CareService(f.db).overview(f.owner.user.id, f.pet.id, {});
  const operations = await new OperationsService(f.db).summary(f.owner.user.id, f.owner.household.id, {});
  assert.ok(overview.device);
  assert.equal(overview.device.credential.version, 3); assert.equal(overview.device.credential.status, 'active');
  assert.equal(operations.devices[0].credential.version, 3); assert.equal(operations.devices[0].credential.status, 'active');
  const serial = JSON.stringify({ view: await f.credentials.view(f.owner.user.id, f.device.device_id), detail: await f.devices.detail(f.owner.user.id, f.device.device_id), overview, operations, audits });
  for (const secret of [f.device.device_token, first.device_token, second.device_token, hash(first.device_token), hash(second.device_token), 'secret_hash']) assert.ok(!serial.includes(secret), secret);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n, 0);
  assert.equal((await f.db.get('SELECT secret_hash FROM devices WHERE id=?', f.device.device_id))!.secret_hash, hash(second.device_token));
});

test('管理员白名单独立且仅重签未认领设备绑定码，旧码失效并重置尝试', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const pending = await provisionDevice(f.db, { serial_no: 'UNCLAIMED-REISSUE' });
  process.env.SUPPORT_ADMIN_USER_IDS = f.admin.user.id;
  await assert.rejects(f.credentials.adminClaimCode(f.admin.user.id, pending.device_id, reason), status(403));
  process.env.DEVICE_ADMIN_USER_IDS = f.admin.user.id;
  await f.db.run('UPDATE devices SET claim_attempts=5 WHERE id=?', pending.device_id);
  f.advance(1000);
  const renewed = await f.credentials.adminClaimCode(f.admin.user.id, pending.device_id, reason);
  assert.notEqual(renewed.claim_code, pending.claim_code);
  assert.equal(Date.parse(renewed.claim_expires_at) - f.db.clock().getTime(), 30 * 60000);
  assert.equal((await f.db.get('SELECT claim_attempts FROM devices WHERE id=?', pending.device_id))!.claim_attempts, 0);
  const target = await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'Claim reissue target' });
  await assert.rejects(f.devices.claim(f.owner.user.id, { ...pending, pet_id: target.id }), status(400));
  await f.devices.claim(f.owner.user.id, { ...renewed, pet_id: target.id });
  await assert.rejects(f.credentials.adminClaimCode(f.admin.user.id, pending.device_id, reason), status(409));
  await assert.rejects(f.credentials.adminRotate(f.admin.user.id, pending.device_id, reason), status(409));
  const audit = (await f.db.get("SELECT * FROM audit_logs WHERE action='device.claim_code_reissued'"))!;
  assert.equal(audit.actor_id, f.admin.user.id); assert.equal(audit.resource_id, pending.device_id);
  for (const secret of [pending.claim_code, renewed.claim_code, hash(renewed.claim_code)]) assert.ok(!audit.metadata_json.includes(secret));
});

test('释放后的吊销设备仅配置管理员可恢复，白名单不能授权不存在账号', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.credentials.revoke(f.owner.user.id, f.device.device_id, reason);
  await f.devices.unbind(f.owner.user.id, f.device.device_id);
  await assert.rejects(f.credentials.adminRotate(f.admin.user.id, f.device.device_id, reason), status(403));
  process.env.DEVICE_ADMIN_USER_IDS = f.admin.user.id;
  await assert.rejects(f.credentials.adminRotate(f.admin.user.id, f.device.device_id, reason), status(409));
  await f.devices.release(f.owner.user.id, f.device.device_id);
  process.env.DEVICE_ADMIN_USER_IDS = 'nonexistent-admin';
  await assert.rejects(f.credentials.adminRotate('nonexistent-admin', f.device.device_id, reason), status(403));
  process.env.DEVICE_ADMIN_USER_IDS = f.admin.user.id;
  const restored = await f.credentials.adminRotate(f.admin.user.id, f.device.device_id, reason);
  assert.equal(restored.credential.status, 'active'); assert.equal(restored.credential.version, 2);
  assert.equal((await f.telemetry.ingest(f.event(), restored.device_token)).duplicate, false);
  await assert.rejects(f.telemetry.ingest(f.event(), f.device.device_token), status(401));
});

test('等待遥测写事务期间轮换凭证，旧token必须在真正入队前重新验证', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const transaction = f.db.transaction.bind(f.db);
  let change = true;
  f.db.transaction = async <T>(work: () => T | Promise<T>): Promise<T> => {
    if (change) { change = false; await f.credentials.rotate(f.owner.user.id, f.device.device_id, reason); }
    return transaction(work);
  };
  const event = f.event();
  await assert.rejects(f.telemetry.ingest(event, f.device.device_token), status(401));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM device_events'))!.n, 0);
});

test('命令维护期间轮换或吊销后，poll和ack都重新验证凭证', async () => {
  for (const action of ['poll', 'ack'] as const) {
    const f = await fixture();
    try {
      const command = await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, { mode: 'alert', interval_seconds: 15 });
      class CredentialChangedReporting extends ReportingService {
        override async expire() {
          await super.expire();
          if (action === 'poll') await f.credentials.rotate(f.owner.user.id, f.device.device_id, reason);
          else await f.credentials.revoke(f.owner.user.id, f.device.device_id, reason);
        }
      }
      const reporting = new CredentialChangedReporting(f.db);
      const request = action === 'poll' ? reporting.poll(f.device.device_id, f.device.device_token)
        : reporting.acknowledge(f.device.device_id, command.command_id, f.device.device_token, { status: 'applied', applied_version: command.desired_version });
      await assert.rejects(request, status(401));
      assert.equal((await f.db.get('SELECT status FROM device_commands WHERE id=?', command.command_id))!.status, 'pending');
    } finally { await f.db.close(); }
  }
});
