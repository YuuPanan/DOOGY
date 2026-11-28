import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { DevicesService, provisionDevice } from '../src/devices';
import { CareService } from '../src/care';
import { FencesService } from '../src/fences';
import { NotificationService } from '../src/notifications';
import { ReportingService } from '../src/reporting';
import { SharesService } from '../src/shares';
import { SupportService } from '../src/support';
import { TelemetryService } from '../src/telemetry';
import { SafetyService } from '../src/safety';
import { ObservationsService } from '../src/observations';
import { PrivacyService } from '../src/privacy';
import { tables } from '../scripts/migrate-postgres';

const password = 'Synthetic-privacy-test-2026';
const status = (code: number, errorCode?: string) => (error: unknown) => error instanceof HttpException && error.getStatus() === code
  && (!errorCode || (error.getResponse() as Row).code === errorCode);
beforeEach(() => { process.env.DATA_MODE = 'offline'; });

async function fixture() {
  const db = new Db(':memory:', () => new Date('2026-11-17T06:00:00Z')), identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `${name}@example.invalid`, password });
  const owner = await register('privacy-owner'), member = await register('privacy-member'), outsider = await register('privacy-outsider');
  const invitation = await identity.invite(owner.user.id, owner.household.id, { email: member.user.email, role: 'caregiver' });
  await identity.accept(member.user.id, invitation.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Shared privacy pet' }, 'privacy-pet');
  const otherPet = await identity.createPet(outsider.user.id, { household_id: outsider.household.id, name: 'Unrelated privacy pet' }, 'unrelated-pet');
  const notifications = new NotificationService(db), devices = new DevicesService(db), care = new CareService(db);
  const telemetry = new TelemetryService(db, devices, notifications), privacy = new PrivacyService(db);
  return { db, identity, owner, member, outsider, pet, otherPet, notifications, devices, care, telemetry, privacy };
}

async function populated(f: Awaited<ReturnType<typeof fixture>>) {
  const device = await provisionDevice(f.db, { serial_no: 'PRIVACY-BOUND' });
  await f.devices.claim(f.owner.user.id, { ...device, pet_id: f.pet.id });
  const fence = await new FencesService(f.db).create(f.owner.user.id, { pet_id: f.pet.id, name: 'Shared private fence',
    geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
  const envelope = (seq: number) => ({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
    device_ts: f.db.now(), boot_id: 'privacy-fixture', seq, event_type: 'location.reported',
    payload: { lat: 31.23, lon: 121.47, accuracy_m: 5, source: 'gnss', battery_pct: 5, signal: { private: 'privacy-signal-copy' } } });
  await f.telemetry.ingest(envelope(1), device.device_token);
  await f.telemetry.ingest({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
    device_ts: f.db.now(), boot_id: 'privacy-fixture', seq: 2, event_type: 'activity.reported', payload: {
      start_at: '2026-11-17T05:00:00Z', end_at: f.db.now(), steps: 100, raw_metrics: { private: 'privacy-metric-copy' }
    } }, device.device_token);
  await f.telemetry.work();
  const pending = envelope(3); await f.telemetry.ingest(pending, device.device_token);
  const record = await f.care.create(f.member.user.id, { pet_id: f.pet.id, type: 'note', recorded_at: f.db.now(),
    value: { text: 'Shared care fact' }, notes: 'Shared care note' }, 'privacy-care');
  await f.care.update(f.member.user.id, record.id, { notes: 'Shared revised note' });
  await f.care.feedback(f.member.user.id, f.pet.id, { feature_date: '2026-11-17', assessment: 'other', comment: 'Private feedback', evidence: { pet_id: f.pet.id } });
  await new ObservationsService(f.db, f.care).get(f.owner.user.id, f.pet.id, { date: '2026-11-17' });
  await new ReportingService(f.db).lostMode(f.owner.user.id, device.device_id, { enabled: true });
  const share = await new SharesService(f.db).create(f.member.user.id, f.pet.id, { consent: true });
  const ticket = await new SupportService(f.db).create(f.member.user.id, { device_id: device.device_id, category: 'other',
    description: 'Private account ticket', diagnostics_consent: true }, 'privacy-ticket');
  const safety = (await f.db.get('SELECT id FROM safety_events WHERE pet_id=?', f.pet.id))!;
  await new SafetyService(f.db).acknowledge(f.member.user.id, safety.id, { note: 'Private acknowledgement' }, 'privacy-ack');
  await f.notifications.registerToken(f.member.user.id, { platform: 'android', token: 'privacy-private-push-token' });
  await f.notifications.updatePreferences(f.member.user.id, { battery: false });
  return { device, fence, record, share, ticket, pending, safety };
}

async function snapshot(db: Db) {
  const names = (await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map(row => row.name);
  const result: Row = {};
  for (const name of names) result[name] = await db.all(`SELECT * FROM ${name} ORDER BY rowid`);
  return result;
}

test('共享删除：预览不写入，密码、确认和owner校验失败完整回滚', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await populated(f);
  const before = await snapshot(f.db);
  await f.privacy.petPreview(f.owner.user.id, f.pet.id);
  await f.privacy.householdPreview(f.owner.user.id, f.owner.household.id);
  await f.privacy.accountPreview(f.owner.user.id);
  assert.deepEqual(await snapshot(f.db), before);
  await assert.rejects(f.privacy.deletePet(f.owner.user.id, f.pet.id, { password: 'Wrong-password-2026', confirmation: f.pet.id }), status(401));
  await assert.rejects(f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.otherPet.id }), status(400));
  await assert.rejects(f.privacy.deletePet(f.member.user.id, f.pet.id, { password, confirmation: f.pet.id }), status(403));
  await assert.rejects(f.privacy.deleteHousehold(f.outsider.user.id, f.owner.household.id, { password, confirmation: f.owner.household.id }), status(404));
  assert.deepEqual(await snapshot(f.db), before);
});

test('共享宠物删除：队列、位置、快照、照护修订、授权和幂等副本清除，其他家庭不受影响', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const seeded = await populated(f);
  const unrelated = await f.care.create(f.outsider.user.id, { pet_id: f.otherPet.id, type: 'note', recorded_at: f.db.now(), value: { text: 'Keep unrelated fact' } }, 'unrelated-care');
  await f.db.run('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?)', f.outsider.user.id, 'POST /care-records', 'former-member-copy',
    JSON.stringify({ pet_id: f.pet.id }), JSON.stringify({ ...seeded.record, notes: 'Former member cached private note' }), f.db.now());
  await f.db.audit(f.outsider.user.id, 'synthetic.former-member.read', seeded.record.id, { pet_id: f.pet.id, note: 'Former member private audit copy' });
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  for (const table of ['device_events', 'locations', 'activity_samples', 'geofences', 'safety_events', 'device_bindings',
    'behavior_feedback', 'daily_summaries', 'activity_observations', 'activity_versions', 'location_shares', 'support_tickets']) {
    assert.equal((await f.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE pet_id=?`, f.pet.id))!.n, 0, table);
  }
  for (const table of ['geofence_states', 'geofence_evaluations', 'notifications', 'safety_acknowledgements', 'care_record_revisions',
    'support_ticket_history', 'reporting_policies', 'device_commands', 'lost_mode_sessions']) {
    assert.equal((await f.db.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n, 0, table);
  }
  assert.equal(await f.db.get('SELECT id FROM pets WHERE id=?', f.pet.id), undefined);
  assert.equal(await f.db.get('SELECT id FROM care_records WHERE id=?', seeded.record.id), undefined);
  assert.ok(await f.db.get('SELECT id FROM care_records WHERE id=?', unrelated.id));
  assert.ok(await f.db.get('SELECT id FROM pets WHERE id=?', f.otherPet.id));
  assert.ok(await f.db.get('SELECT id FROM devices WHERE id=?', seeded.device.device_id));
  const state = (await f.db.get('SELECT * FROM device_state WHERE device_id=?', seeded.device.device_id))!;
  assert.equal(state.last_location_id, null); assert.equal(state.signal_json, null);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM idempotency_keys WHERE user_id IN (?,?)', f.owner.user.id, f.member.user.id))!.n, 0);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE user_id=? AND key=?', f.outsider.user.id, 'former-member-copy'), undefined);
  const remainingAudit = JSON.stringify(await f.db.all('SELECT * FROM audit_logs'));
  assert.ok(!remainingAudit.includes('Former member private audit copy'));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM privacy_deletions WHERE kind=? AND resource_id=?', 'pet', f.pet.id))!.n, 1);
  await assert.rejects(f.telemetry.ingest(seeded.pending, seeded.device.device_token), status(409));
  assert.equal(await f.telemetry.work(), 0);
});

test('成员注销：个人凭证与授权删除，共享事实保留匿名作者，其他用户仍可访问', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const seeded = await populated(f);
  const savedHash = (await f.db.get('SELECT password_hash FROM users WHERE id=?', f.member.user.id))!.password_hash;
  await f.privacy.closeAccount(f.member.user.id, { password, confirmation: 'DELETE' });
  const closed = (await f.db.get('SELECT * FROM users WHERE id=?', f.member.user.id))!;
  assert.ok(closed.closed_at); assert.notEqual(closed.email, f.member.user.email); assert.notEqual(closed.password_hash, savedHash);
  for (const table of ['sessions', 'push_tokens', 'notification_preferences', 'notifications', 'idempotency_keys', 'household_members', 'safety_acknowledgements']) {
    assert.equal((await f.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`, f.member.user.id))!.n, 0, table);
  }
  for (const table of ['support_tickets', 'location_shares', 'behavior_feedback']) {
    assert.equal((await f.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE created_by=?`, f.member.user.id))!.n, 0, table);
  }
  assert.equal(await f.db.get('SELECT id FROM households WHERE id=?', f.member.household.id), undefined);
  assert.ok(await f.db.pet(f.owner.user.id, f.pet.id));
  const history = await f.care.history(f.owner.user.id, seeded.record.id);
  assert.equal(history.current.created_by, f.member.user.id); assert.equal(history.current.notes, 'Shared revised note');
  assert.equal(history.revisions.length, 1);
  assert.equal(await f.db.get('SELECT id FROM support_tickets WHERE id=?', seeded.ticket.id), undefined);
  await assert.rejects(f.identity.userFromAccess(f.member.access_token), status(401));
  await assert.rejects(f.identity.refresh({ refresh_token: f.member.refresh_token }), status(401));
  await assert.rejects(f.identity.login({ email: f.member.user.email, password }), status(401));
  assert.equal(await f.identity.userFromAccess(f.owner.access_token), f.owner.user.id);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM privacy_deletions WHERE kind=? AND resource_id=?', 'account', f.member.user.id))!.n, 1);
});

test('多成员owner必须先转移家庭与当前设备，随后注销不会删除继任者共享业务', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const seeded = await populated(f);
  await assert.rejects(f.privacy.closeAccount(f.owner.user.id, { password, confirmation: 'DELETE' }), status(409, 'OWNER_TRANSFER_REQUIRED'));
  assert.equal(await f.identity.userFromAccess(f.owner.access_token), f.owner.user.id);
  await assert.rejects(f.privacy.transferOwner(f.owner.user.id, f.owner.household.id, { password, new_owner_user_id: f.outsider.user.id }), status(409, 'OWNER_TARGET_NOT_MEMBER'));
  await f.privacy.transferOwner(f.owner.user.id, f.owner.household.id, { password, new_owner_user_id: f.member.user.id });
  assert.equal((await f.db.get('SELECT owner_user_id FROM households WHERE id=?', f.owner.household.id))!.owner_user_id, f.member.user.id);
  assert.equal((await f.db.get('SELECT role FROM household_members WHERE household_id=? AND user_id=?', f.owner.household.id, f.owner.user.id))!.role, 'caregiver');
  assert.equal((await f.db.get('SELECT owner_user_id FROM devices WHERE id=?', seeded.device.device_id))!.owner_user_id, f.member.user.id);
  await f.privacy.closeAccount(f.owner.user.id, { password, confirmation: 'DELETE' });
  assert.ok(await f.db.pet(f.member.user.id, f.pet.id));
  assert.equal((await f.db.get('SELECT credential_status FROM devices WHERE id=?', seeded.device.device_id))!.credential_status, 'active');
  assert.ok(await f.db.get('SELECT id FROM locations WHERE pet_id=?', f.pet.id));
  await assert.rejects(f.identity.userFromAccess(f.owner.access_token), status(401));
});

test('注销独享家庭：整户业务清理、设备释放吊销且旧设备凭证失效', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.member.user.id);
  const seeded = await populated({ ...f, member: f.owner });
  await f.privacy.closeAccount(f.owner.user.id, { password, confirmation: 'DELETE' });
  assert.equal(await f.db.get('SELECT id FROM households WHERE id=?', f.owner.household.id), undefined);
  assert.equal(await f.db.get('SELECT id FROM pets WHERE id=?', f.pet.id), undefined);
  const device = (await f.db.get('SELECT * FROM devices WHERE id=?', seeded.device.device_id))!;
  assert.equal(device.owner_user_id, null); assert.equal(device.credential_status, 'revoked'); assert.equal(device.claim_hash, null);
  await assert.rejects(f.telemetry.ingest(seeded.pending, seeded.device.device_token), status(401));
  assert.ok(await f.db.pet(f.outsider.user.id, f.otherPet.id));
});

test('成员拥有仍在共享家庭绑定的设备，注销前必须处理所有权或解绑释放', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const device = await provisionDevice(f.db, { serial_no: 'PRIVACY-MEMBER-OWNED' });
  await f.devices.claim(f.member.user.id, { ...device, pet_id: f.pet.id });
  await assert.rejects(f.privacy.closeAccount(f.member.user.id, { password, confirmation: 'DELETE' }), status(409, 'DEVICE_RELEASE_REQUIRED'));
  assert.equal(await f.identity.userFromAccess(f.member.access_token), f.member.user.id);
  assert.equal((await f.db.get('SELECT owner_user_id FROM devices WHERE id=?', device.device_id))!.owner_user_id, f.member.user.id);
  await f.devices.unbind(f.member.user.id, device.device_id);
  await f.devices.release(f.member.user.id, device.device_id);
  await f.privacy.closeAccount(f.member.user.id, { password, confirmation: 'DELETE' });
  assert.ok(await f.db.pet(f.owner.user.id, f.pet.id));
});

test('删除旧宠物时设备已在其他家庭重绑，保留新家庭状态、命令与凭证', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const seeded = await populated(f);
  const renewed = await f.devices.unbind(f.owner.user.id, seeded.device.device_id);
  await f.devices.release(f.owner.user.id, seeded.device.device_id);
  await f.devices.claim(f.outsider.user.id, { device_id: seeded.device.device_id, claim_code: renewed.claim_code, pet_id: f.otherPet.id });
  await f.telemetry.ingest({ ...seeded.pending, event_id: randomUUID(), seq: 10, payload: {
    lat: 30.3, lon: 120.2, accuracy_m: 5, source: 'gnss', signal: { private: 'new-household-signal' }
  } }, seeded.device.device_token);
  await f.telemetry.work();
  await new ReportingService(f.db).lostMode(f.outsider.user.id, seeded.device.device_id, { enabled: true });
  const before = {
    state: await f.db.get('SELECT * FROM device_state WHERE device_id=?', seeded.device.device_id),
    policy: await f.db.get('SELECT * FROM reporting_policies WHERE device_id=?', seeded.device.device_id),
    device: await f.db.get('SELECT * FROM devices WHERE id=?', seeded.device.device_id)
  };
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  assert.deepEqual(await f.db.get('SELECT * FROM device_state WHERE device_id=?', seeded.device.device_id), before.state);
  assert.deepEqual(await f.db.get('SELECT * FROM reporting_policies WHERE device_id=?', seeded.device.device_id), before.policy);
  assert.deepEqual(await f.db.get('SELECT * FROM devices WHERE id=?', seeded.device.device_id), before.device);
  assert.equal((await f.db.get('SELECT pet_id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', seeded.device.device_id))!.pet_id, f.otherPet.id);
  assert.ok(await f.db.get('SELECT id FROM locations WHERE pet_id=?', f.otherPet.id));
  await assert.rejects(f.telemetry.ingest(seeded.pending, seeded.device.device_token), status(409));
  assert.equal(await f.telemetry.work(), 0);
});

test('旧宠物已解绑但设备尚未重绑，删除时清理残留信号与状态缓存', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const seeded = await populated(f);
  await f.devices.unbind(f.owner.user.id, seeded.device.device_id);
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  const state = (await f.db.get('SELECT * FROM device_state WHERE device_id=?', seeded.device.device_id))!;
  assert.equal(state.signal_json, null); assert.equal(state.reported_at, null); assert.equal(state.last_location_id, null);
  assert.ok(await f.db.get('SELECT id FROM devices WHERE id=?', seeded.device.device_id));
});

test('登录已校验旧密码后等待写事务，注销先提交时不能再签发新会话', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const transaction = f.db.transaction.bind(f.db);
  let calls = 0, arrived!: () => void, resume!: () => void;
  const atSessionWrite = new Promise<void>(resolve => { arrived = resolve; });
  const releaseSessionWrite = new Promise<void>(resolve => { resume = resolve; });
  f.db.transaction = async <T>(work: () => T | Promise<T>): Promise<T> => {
    if (++calls === 2) { arrived(); await releaseSessionWrite; }
    return transaction(work);
  };
  const login = assert.rejects(f.identity.login({ email: f.member.user.email, password }), status(401));
  await atSessionWrite;
  try { await f.privacy.closeAccount(f.member.user.id, { password, confirmation: 'DELETE' }); }
  finally { resume(); }
  await login;
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', f.member.user.id))!.n, 0);
  assert.ok((await f.db.get('SELECT closed_at FROM users WHERE id=?', f.member.user.id))!.closed_at);
});

test('删除日志保留同毫秒内转移先于注销的因果顺序，旧副本重放后共享资料与新owner保留', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const device = await provisionDevice(f.db, { serial_no: 'PRIVACY-REPLAY' });
  await f.devices.claim(f.owner.user.id, { ...device, pet_id: f.pet.id });
  const baseline = await snapshot(f.db), restored = new Db(':memory:', f.db.clock);
  t.after(() => restored.close());
  for (const table of tables) for (const row of baseline[table]) {
    const columns = Object.keys(row);
    await restored.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]));
  }
  const ids = ['ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000001'];
  f.db.id = () => ids.shift()! as ReturnType<typeof randomUUID>;
  await f.privacy.transferOwner(f.owner.user.id, f.owner.household.id, { password, new_owner_user_id: f.member.user.id });
  await f.privacy.closeAccount(f.owner.user.id, { password, confirmation: 'DELETE' });
  const receipts = await f.privacy.receipts();
  assert.deepEqual(receipts.map(row => row.kind), ['ownership_transfer', 'account']);
  const replay = new PrivacyService(restored);
  assert.equal((await replay.replay(receipts)).applied, 2);
  assert.equal((await replay.replay(receipts)).applied, 0);
  assert.ok((await restored.get('SELECT closed_at FROM users WHERE id=?', f.owner.user.id))!.closed_at);
  assert.equal((await restored.get('SELECT owner_user_id FROM households WHERE id=?', f.owner.household.id))!.owner_user_id, f.member.user.id);
  assert.equal((await restored.get('SELECT owner_user_id FROM devices WHERE id=?', device.device_id))!.owner_user_id, f.member.user.id);
  assert.ok(await restored.pet(f.member.user.id, f.pet.id));
  assert.equal((await restored.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', f.owner.user.id))!.n, 0);
});
