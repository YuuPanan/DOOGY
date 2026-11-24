import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { DevicesService, provisionDevice } from '../src/devices';
import { ReportingService } from '../src/reporting';
import { SharesService } from '../src/shares';
import { TelemetryService } from '../src/telemetry';
import { NotificationService } from '../src/notifications';
import { FencesService } from '../src/fences';

const status = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
async function setup(startLost = true, duration = 3600) {
  let time = Date.parse('2026-11-17T06:00:00Z'), seq = 0;
  const db = new Db(':memory:', () => new Date(time)), identity = new IdentityService(db);
  const owner = await identity.register({ email: 'share-owner@example.invalid', password: 'Synthetic-share-password' });
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '分享宠物' });
  const device = await provisionDevice(db, { serial_no: 'SHARE-DEVICE' }), devices = new DevicesService(db);
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  const reporting = new ReportingService(db), shares = new SharesService(db);
  const telemetry = new TelemetryService(db, devices, new NotificationService(db));
  if (startLost) await reporting.lostMode(owner.user.id, device.device_id, { enabled: true, expires_in_seconds: duration });
  const member = async (email: string, role: 'viewer' | 'caregiver') => {
    const user = await identity.register({ email, password: 'Synthetic-share-password' });
    const invite = await identity.invite(owner.user.id, owner.household.id, { email, role });
    await identity.accept(user.user.id, invite.token);
    return user;
  };
  const create = async (extra = {}) => await shares.create(owner.user.id, pet.id, { consent: true, ...extra });
  const point = async (accuracy = 10) => {
    await telemetry.ingest({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'share-boot',
      seq: seq++, device_ts: db.now(), event_type: 'location.reported',
      payload: { lat: 31.23, lon: 121.47, accuracy_m: accuracy, source: 'gnss', battery_pct: 50 } }, device.device_token);
    await telemetry.work();
  };
  return { db, identity, owner, pet, device, devices, reporting, shares, member, create, point, advance: (seconds: number) => { time += seconds * 1000; } };
}

test('分享要求显式同意与有效走失会话，令牌只在创建时返回且只保存散列', async t => {
  const f = await setup(false); t.after(async () => await f.db.close());
  await assert.rejects(async () => await f.shares.create(f.owner.user.id, f.pet.id, {}));
  await assert.rejects(async () => await f.create(), status(409));
  await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true });
  const share = await f.create(), another = await f.create();
  assert.match(share.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(share.token, another.token);
  assert.equal(share.public_path, `/api/v1/location-shares/${share.token}`);
  const stored = (await f.db.get('SELECT * FROM location_shares WHERE id=?', share.id))!;
  assert.equal(stored.token_hash, createHash('sha256').update(share.token).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(share.token));
  assert.ok(!JSON.stringify((await f.db.all('SELECT * FROM audit_logs'))).includes(share.token));
  assert.equal((await f.db.get('SELECT COUNT(*) n FROM idempotency_keys'))!.n, 0);
  const list = await f.shares.list(f.owner.user.id, f.pet.id);
  assert.equal(list.items.length, 2);
  assert.ok(list.items.every(row => !('token' in row) && !('token_hash' in row) && !('public_path' in row)));
});

test('分享创建/列表遵守家庭写权限，只有创建者或家庭所有者可以撤销', async t => {
  const f = await setup(); t.after(async () => await f.db.close());
  const viewer = await f.member('share-viewer@example.invalid', 'viewer');
  const caregiver = await f.member('share-caregiver@example.invalid', 'caregiver');
  const other = await f.member('share-other-caregiver@example.invalid', 'caregiver');
  const outsider = await f.identity.register({ email: 'share-outsider@example.invalid', password: 'Synthetic-share-password' });
  await assert.rejects(async () => await f.shares.create(viewer.user.id, f.pet.id, { consent: true }), status(403));
  await assert.rejects(async () => await f.shares.list(viewer.user.id, f.pet.id), status(403));
  await assert.rejects(async () => await f.shares.create(outsider.user.id, f.pet.id, { consent: true }), status(404));
  const share = await f.shares.create(caregiver.user.id, f.pet.id, { consent: true });
  await assert.rejects(async () => await f.shares.revoke(other.user.id, share.id), status(403));
  await assert.rejects(async () => await f.shares.revoke(outsider.user.id, share.id), status(404));
  assert.ok((await f.shares.revoke(f.owner.user.id, share.id)).revoked_at);
  await assert.rejects(async () => await f.shares.resolve(share.token), status(404));
});

test('分享有效期不超过走失会话，所有无效公开令牌统一返回404', async t => {
  const f = await setup(true, 120); t.after(async () => await f.db.close());
  const share = await f.create({ expires_in_seconds: 86400 });
  assert.equal(Date.parse(share.expires_at) - f.db.clock().getTime(), 120000);
  assert.equal((await f.shares.resolve(share.token)).location, null);
  f.advance(110);
  assert.equal(Date.parse((await f.create()).expires_at) - f.db.clock().getTime(), 10000);
  f.advance(11);
  for (const token of [share.token, 'missing', 'x'.repeat(43)]) {
    await assert.rejects(async () => await f.shares.resolve(token), (error: unknown) => error instanceof HttpException
      && error.getStatus() === 404 && (error.getResponse() as any).code === 'SHARE_NOT_FOUND');
  }
});

test('撤销重复调用只记录一次审计，列表游标不返回令牌', async t => {
  const f = await setup(); t.after(async () => await f.db.close());
  const shares = [(await f.create()), (await f.create()), (await f.create())];
  const first = await f.shares.revoke(f.owner.user.id, shares[0].id);
  f.advance(10);
  assert.deepEqual((await f.shares.revoke(f.owner.user.id, shares[0].id)), first);
  assert.equal((await f.db.get("SELECT COUNT(*) n FROM audit_logs WHERE action='location_share.revoked'"))!.n, 1);
  const page1 = await f.shares.list(f.owner.user.id, f.pet.id, { limit: 2 });
  assert.ok(page1.next_cursor);
  const page2 = await f.shares.list(f.owner.user.id, f.pet.id, { limit: 2, cursor: page1.next_cursor });
  assert.equal(page2.next_cursor, null);
  assert.equal(new Set([...page1.items, ...page2.items].map(row => row.id)).size, 3);
  assert.ok(!JSON.stringify(page1).includes(shares[1].token));
});

test('关闭或重新开启走失会话不能恢复旧分享，解绑重绑同一宠物也使旧分享失效', async t => {
  const f = await setup(); t.after(async () => await f.db.close());
  await f.point();
  const original = await f.create();
  await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: false });
  await assert.rejects(async () => await f.shares.resolve(original.token), status(404));
  await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true });
  await assert.rejects(async () => await f.shares.resolve(original.token), status(404));
  const next = await f.create();
  const unbound = await f.devices.unbind(f.owner.user.id, f.device.device_id);
  f.advance(1);
  await f.devices.claim(f.owner.user.id, { device_id: f.device.device_id, pet_id: f.pet.id, claim_code: unbound.claim_code });
  await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: true });
  await assert.rejects(async () => await f.shares.resolve(next.token), status(404));
  assert.equal((await f.shares.resolve((await f.create()).token)).location, null);
});

test('分享创建者的写权限降低或家庭访问被撤销，公开位置随即失效', async t => {
  const f = await setup(); t.after(async () => await f.db.close());
  const caregiver = await f.member('share-removed@example.invalid', 'caregiver');
  const first = await f.shares.create(caregiver.user.id, f.pet.id, { consent: true });
  assert.equal((await f.shares.resolve(first.token)).pet.id, f.pet.id);
  await f.identity.changeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id, { role: 'viewer' });
  await assert.rejects(async () => await f.shares.resolve(first.token), status(404));
  assert.ok((await f.shares.revoke(caregiver.user.id, first.id)).revoked_at);
  await f.identity.changeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id, { role: 'caregiver' });
  const second = await f.shares.create(caregiver.user.id, f.pet.id, { consent: true });
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id);
  await assert.rejects(async () => await f.shares.resolve(second.token), status(404));
});

test('恢复角色或重新邀请不能复活旧链接，移出家庭永久清除诊断授权', async t => {
  const f = await setup(); t.after(async () => await f.db.close());
  const caregiver = await f.member('share-restored@example.invalid', 'caregiver');
  const share = await f.shares.create(caregiver.user.id, f.pet.id, { consent: true });
  const diagnosticId = f.db.id(), binding = (await f.db.get('SELECT id FROM device_bindings WHERE pet_id=? AND unbound_at IS NULL', f.pet.id))!;
  await f.db.run(`INSERT INTO support_tickets(id,device_id,pet_id,binding_id,created_by,category,description,
    diagnostics_consented_at,diagnostics_expires_at,diagnostics_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    diagnosticId, f.device.device_id, f.pet.id, binding.id, caregiver.user.id, 'location', 'synthetic diagnostic',
    f.db.now(), '2026-11-24T06:00:00.000Z', '{"synthetic":true}', f.db.now(), f.db.now());
  await f.identity.changeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id, { role: 'viewer' });
  assert.ok((await f.db.get('SELECT revoked_at FROM location_shares WHERE id=?', share.id))!.revoked_at);
  assert.equal((await f.db.get('SELECT diagnostics_revoked_at FROM support_tickets WHERE id=?', diagnosticId))!.diagnostics_revoked_at, null);
  await f.identity.changeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id, { role: 'caregiver' });
  await assert.rejects(async () => await f.shares.resolve(share.token), status(404));
  const another = await f.shares.create(caregiver.user.id, f.pet.id, { consent: true });
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id);
  const cleared = (await f.db.get('SELECT diagnostics_json,diagnostics_revoked_at FROM support_tickets WHERE id=?', diagnosticId))!;
  assert.equal(cleared.diagnostics_json, null);
  assert.ok(cleared.diagnostics_revoked_at);
  const invite = await f.identity.invite(f.owner.user.id, f.owner.household.id, { email: caregiver.user.email, role: 'caregiver' });
  await f.identity.accept(caregiver.user.id, invite.token);
  await assert.rejects(async () => await f.shares.resolve(another.token), status(404));
  assert.equal((await f.db.get('SELECT diagnostics_json FROM support_tickets WHERE id=?', diagnosticId))!.diagnostics_json, null);
  assert.equal((await f.shares.resolve((await f.shares.create(caregiver.user.id, f.pet.id, { consent: true })).token)).pet.id, f.pet.id);
});

test('解绑永久撤销对应分享与诊断，显式撤销时间保持不变', async t => {
  const f = await setup(); t.after(async () => await f.db.close());
  const revoked = await f.create(), pending = await f.create();
  const before = (await f.shares.revoke(f.owner.user.id, revoked.id)).revoked_at;
  const diagnosticId = f.db.id(), binding = (await f.db.get('SELECT id FROM device_bindings WHERE pet_id=? AND unbound_at IS NULL', f.pet.id))!;
  await f.db.run(`INSERT INTO support_tickets(id,device_id,pet_id,binding_id,created_by,category,description,
    diagnostics_consented_at,diagnostics_expires_at,diagnostics_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    diagnosticId, f.device.device_id, f.pet.id, binding.id, f.owner.user.id, 'location', 'synthetic diagnostic',
    f.db.now(), '2026-11-24T06:00:00.000Z', '{"synthetic":true}', f.db.now(), f.db.now());
  f.advance(10);
  await f.devices.unbind(f.owner.user.id, f.device.device_id);
  assert.equal((await f.db.get('SELECT revoked_at FROM location_shares WHERE id=?', revoked.id))!.revoked_at, before);
  assert.ok((await f.db.get('SELECT revoked_at FROM location_shares WHERE id=?', pending.id))!.revoked_at);
  const cleared = (await f.db.get('SELECT diagnostics_json,diagnostics_revoked_at FROM support_tickets WHERE id=?', diagnosticId))!;
  assert.equal(cleared.diagnostics_json, null);
  assert.ok(cleared.diagnostics_revoked_at);
});

test('公开响应仅含最小定位信息，保留差精度/陈旧标记及受限回退位置', async t => {
  const f = await setup(); t.after(async () => await f.db.close());
  await new FencesService(f.db).create(f.owner.user.id, { pet_id: f.pet.id, name: '私人家庭围栏', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
  const share = await f.create();
  assert.equal((await f.shares.resolve(share.token)).location, null);
  await f.point();
  assert.equal((await f.shares.resolve(share.token)).location?.usable_for_tracking, true);
  f.advance(10); await f.point(500);
  const response = await f.shares.resolve(share.token);
  assert.equal(response.location?.usable_for_tracking, false);
  assert.ok(response.location?.quality_flags.includes('poor_accuracy'));
  assert.equal(response.last_usable_location?.usable_for_tracking, true);
  assert.deepEqual(Object.keys(response.location!).sort(), ['accuracy_m', 'device_ts', 'freshness', 'lat', 'lon', 'quality_flags', 'received_at', 'source', 'usable_for_tracking'].sort());
  const json = JSON.stringify(response);
  for (const secret of [f.device.device_token, f.owner.user.email, '私人家庭围栏', 'token_hash', 'battery_pct', 'device_id', 'geofence_accuracy_limit_m']) assert.ok(!json.includes(secret), secret);
  f.advance(600);
  const stale = await f.shares.resolve(share.token);
  assert.equal(stale.location?.freshness, 'stale');
  assert.equal(stale.location?.usable_for_tracking, false);
  assert.equal(stale.last_usable_location, null);
});
