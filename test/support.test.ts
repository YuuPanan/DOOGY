import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { DevicesService, provisionDevice } from '../src/devices';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';
import { SupportService } from '../src/support';

beforeEach(() => {
  process.env.DATA_MODE = 'offline';
  delete process.env.SUPPORT_ADMIN_USER_IDS;
});
const code = (status: number, expected?: string) => (error: unknown) => error instanceof HttpException && error.getStatus() === status
  && (!expected || (error.getResponse() as any).code === expected);

async function fixture() {
  let now = new Date('2026-11-17T06:00:00Z');
  const db = new Db(':memory:', () => now), identity = new IdentityService(db), devices = new DevicesService(db);
  const register = async (name: string) => await identity.register({ email: `${name}@example.invalid`, password: 'Synthetic-support-2026' });
  const owner = await register('owner'), viewer = await register('viewer'), outsider = await register('outsider'), staff = await register('staff');
  process.env.SUPPORT_ADMIN_USER_IDS = ` ${staff.user.id} `;
  const invite = await identity.invite(owner.user.id, owner.household.id, { email: viewer.user.email, role: 'viewer' });
  await identity.accept(viewer.user.id, invite.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '客服合成宠物' });
  const device = await provisionDevice(db, { serial_no: 'SUPPORT-TEST' });
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  const support = new SupportService(db);
  const create = async (consent = false, user = owner.user.id, description = '定位更新较慢', key?: string) => await support.create(user, {
    device_id: device.device_id, category: 'location', description, diagnostics_consent: consent
  }, key);
  return { db, identity, devices, owner, viewer, outsider, staff, pet, device, support, create,
    advance: (seconds: number) => { now = new Date(now.getTime() + seconds * 1000); } };
}

test('工单限本人查看，viewer可报告问题，跨家庭提交和普通owner客服访问被拒绝', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  const ticket = await f.create(false, f.viewer.user.id);
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.diagnostics.available, false);
  assert.equal((await f.support.detail(f.viewer.user.id, ticket.id)).history.length, 1);
  await assert.rejects(async () => await f.support.detail(f.owner.user.id, ticket.id), code(404));
  assert.equal((await f.support.list(f.owner.user.id, {})).items.length, 0);
  await assert.rejects(async () => await f.create(false, f.outsider.user.id), code(404));
  await assert.rejects(async () => await f.support.adminList(f.owner.user.id, {}), code(403, 'SUPPORT_STAFF_REQUIRED'));
  delete process.env.SUPPORT_ADMIN_USER_IDS;
  process.env.SUPPORT_ADMIN_EMAILS = f.staff.user.email;
  await assert.rejects(async () => await f.support.adminList(f.staff.user.id, {}), code(403));
});

test('默认无诊断授权，创建幂等不重复工单与快照，重放仍校验当前设备权限', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  const ticket = await f.create(false, f.viewer.user.id, '同一问题', 'ticket-key');
  assert.deepEqual((await f.create(false, f.viewer.user.id, '同一问题', 'ticket-key')), ticket);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM support_tickets'))!.n, 1);
  assert.equal((await f.db.get('SELECT diagnostics_json FROM support_tickets WHERE id=?', ticket.id))!.diagnostics_json, null);
  await assert.rejects(async () => await f.create(false, f.viewer.user.id, '不同问题', 'ticket-key'), code(409, 'IDEMPOTENCY_CONFLICT'));
  await assert.rejects(async () => await f.support.diagnostics(f.staff.user.id, f.device.device_id, ticket.id), code(404, 'DIAGNOSTICS_UNAVAILABLE'));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  await assert.rejects(async () => await f.create(false, f.viewer.user.id, '同一问题', 'ticket-key'), code(404));
  // Submitted text remains the creator's ticket; this does not grant device access.
  assert.equal((await f.support.detail(f.viewer.user.id, ticket.id)).description, '同一问题');
});

test('授权诊断保存不可变安全快照，省略精确位置、信号原文、令牌与告警详情', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  const telemetry = new TelemetryService(f.db, f.devices, new NotificationService(f.db));
  const event = { schema_version: '1.0', event_id: 'support-location-1', device_id: f.device.device_id, boot_id: 'support-boot', seq: 1,
    event_type: 'location.reported', device_ts: f.db.now(), payload: { lat: 31.230456, lon: 121.473789, accuracy_m: 10, source: 'gnss',
      battery_pct: 15, signal: { raw_token: 'NEVER_INCLUDE_SIGNAL_SECRET', lat: 88.12345 } }, source_metadata: { token: 'NEVER_INCLUDE_RAW_SECRET' } };
  await telemetry.ingest(event, f.device.device_token);
  f.advance(3); await telemetry.work();
  const ticket = await f.create(true);
  const result = await f.support.diagnostics(f.staff.user.id, f.device.device_id, ticket.id);
  assert.equal(result.snapshot.state.battery_pct, 15);
  assert.equal(result.snapshot.telemetry.event_count, 1);
  assert.equal(result.snapshot.telemetry.queue_delay_p95_ms, 3000);
  assert.equal(result.snapshot.telemetry.processing_delay_p95_ms, 3000);
  assert.equal(result.snapshot.recent_alerts[0].type, 'battery.low');
  const encoded = JSON.stringify(result.snapshot);
  for (const secret of ['31.230456', '121.473789', '88.12345', 'NEVER_INCLUDE', f.device.device_token, f.device.claim_code]) assert.ok(!encoded.includes(secret), secret);
  assert.ok(!/"(?:lat|lon|geometry|payload|signal|secret_hash|token)"\s*:/.test(encoded));
  await f.db.run('UPDATE device_state SET battery_pct=99 WHERE device_id=?', f.device.device_id);
  assert.deepEqual((await f.support.diagnostics(f.staff.user.id, f.device.device_id, ticket.id)).snapshot, result.snapshot);
  assert.ok(!JSON.stringify((await f.support.detail(f.owner.user.id, ticket.id))).includes('snapshot'));
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='support.diagnostics_viewed'"))!.n, 2);
});

test('撤销、七天到期和过期清理均阻止诊断读取，撤销后快照被移除', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  const revoked = await f.create(true), expiring = await f.create(true);
  await assert.rejects(async () => await f.support.revokeConsent(f.viewer.user.id, revoked.id), code(404));
  const result = await f.support.revokeConsent(f.owner.user.id, revoked.id);
  assert.ok(result.diagnostics.revoked_at);
  assert.equal(result.diagnostics.available, false);
  assert.equal((await f.db.get('SELECT diagnostics_json FROM support_tickets WHERE id=?', revoked.id))!.diagnostics_json, null);
  await f.support.revokeConsent(f.owner.user.id, revoked.id);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='support.diagnostics_revoked'"))!.n, 1);
  await assert.rejects(async () => await f.support.diagnostics(f.staff.user.id, f.device.device_id, revoked.id), code(404));
  f.advance(7 * 86400);
  await assert.rejects(async () => await f.support.diagnostics(f.staff.user.id, f.device.device_id, expiring.id), code(404));
  assert.equal((await f.support.expireDiagnostics()), 1);
  assert.equal((await f.db.get('SELECT diagnostics_json FROM support_tickets WHERE id=?', expiring.id))!.diagnostics_json, null);
});

test('成员撤权或解绑/重新绑定使旧工单授权失效，客服不能读取新绑定状态', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  const memberTicket = await f.create(true, f.viewer.user.id), ownerTicket = await f.create(true);
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  await assert.rejects(async () => await f.support.diagnostics(f.staff.user.id, f.device.device_id, memberTicket.id), code(404));
  assert.equal((await f.support.diagnostics(f.staff.user.id, f.device.device_id, ownerTicket.id)).ticket_id, ownerTicket.id);
  const codeToRebind = await f.devices.unbind(f.owner.user.id, f.device.device_id);
  await f.devices.claim(f.owner.user.id, { device_id: f.device.device_id, pet_id: f.pet.id, claim_code: codeToRebind.claim_code });
  await assert.rejects(async () => await f.support.diagnostics(f.staff.user.id, f.device.device_id, ownerTicket.id), code(404));
  assert.equal((await f.support.detail(f.owner.user.id, ownerTicket.id)).diagnostics.available, false);
});

test('客服处理状态和回复保留历史，幂等重放不重复，用户看不到别人的工单', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  const ticket = await f.create(true);
  await assert.rejects(async () => await f.support.update(f.owner.user.id, ticket.id, { status: 'resolved' }), code(403));
  const result = await f.support.update(f.staff.user.id, ticket.id, { status: 'in_progress', reply: '已收到，将检查上报延迟' }, 'status-key');
  assert.equal(result.status, 'in_progress');
  assert.equal(result.history.length, 2);
  assert.deepEqual((await f.support.update(f.staff.user.id, ticket.id, { status: 'in_progress', reply: '已收到，将检查上报延迟' }, 'status-key')), result);
  await f.support.update(f.staff.user.id, ticket.id, { status: 'in_progress', reply: '已收到，将检查上报延迟' });
  f.advance(1);
  await f.support.update(f.staff.user.id, ticket.id, { status: 'resolved', reply: '请先确认当前设备网络' });
  const detail = await f.support.detail(f.owner.user.id, ticket.id);
  assert.equal(detail.status, 'resolved');
  assert.equal(detail.history.length, 3);
  assert.equal(detail.history.at(-1).actor_id, f.staff.user.id);
  await assert.rejects(async () => await f.support.detail(f.outsider.user.id, ticket.id), code(404));
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='support.status_changed'"))!.n, 2);
});

test('重新邀请已移除成员不会恢复旧工单诊断授权，需要重新明确提交授权', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  const ticket = await f.create(true, f.viewer.user.id);
  assert.equal((await f.support.diagnostics(f.staff.user.id, f.device.device_id, ticket.id)).ticket_id, ticket.id);
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  const revoked = (await f.db.get('SELECT diagnostics_revoked_at,diagnostics_json FROM support_tickets WHERE id=?', ticket.id))!;
  assert.ok(revoked.diagnostics_revoked_at);
  assert.equal(revoked.diagnostics_json, null);
  const invite = await f.identity.invite(f.owner.user.id, f.owner.household.id, { email: f.viewer.user.email, role: 'viewer' });
  await f.identity.accept(f.viewer.user.id, invite.token);
  await assert.rejects(async () => await f.support.diagnostics(f.staff.user.id, f.device.device_id, ticket.id), code(404, 'DIAGNOSTICS_UNAVAILABLE'));
  const fresh = await f.create(true, f.viewer.user.id, '重新授权新工单');
  assert.equal((await f.support.diagnostics(f.staff.user.id, f.device.device_id, fresh.id)).ticket_id, fresh.id);
});

test('用户和客服列表支持稳定游标与状态过滤，越权游标和诊断设备不匹配被拒绝', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  const first = await f.create(true), second = await f.create(false), other = await f.create(false, f.viewer.user.id);
  const page = await f.support.list(f.owner.user.id, { limit: 1 });
  const next = await f.support.list(f.owner.user.id, { limit: 1, cursor: page.next_cursor });
  assert.equal(new Set([...page.items, ...next.items].map(row => row.id)).size, 2);
  assert.equal(next.next_cursor, null);
  await assert.rejects(async () => await f.support.list(f.owner.user.id, { cursor: other.id }), code(400, 'INVALID_CURSOR'));
  await f.support.update(f.staff.user.id, first.id, { status: 'resolved' });
  assert.deepEqual((await f.support.list(f.owner.user.id, { status: 'resolved' })).items.map(row => row.id), [first.id]);
  assert.equal((await f.support.adminList(f.staff.user.id, { limit: 2 })).items.length, 2);
  assert.equal((await f.support.adminDetail(f.staff.user.id, second.id)).id, second.id);
  await assert.rejects(async () => await f.support.diagnostics(f.staff.user.id, f.db.id(), first.id), code(404));
});
