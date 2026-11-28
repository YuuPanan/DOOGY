import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
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
import { AccountExportService } from '../src/account-export';
import { tables } from '../scripts/migrate-postgres';

beforeEach(() => { process.env.DATA_MODE = 'offline'; });
const status = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  let time = Date.parse('2026-11-17T06:00:00Z');
  const db = new Db(':memory:', () => new Date(time)), identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `${name}@example.invalid`, password: 'Synthetic-account-export-2026' });
  const owner = await register('export-owner'), viewer = await register('export-viewer'), outsider = await register('export-outsider');
  const invitation = await identity.invite(owner.user.id, owner.household.id, { email: viewer.user.email, role: 'viewer' });
  await identity.accept(viewer.user.id, invitation.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Export pet' });
  return { db, identity, owner, viewer, outsider, pet, exporter: new AccountExportService(db), invitation,
    advance: (milliseconds: number) => { time += milliseconds; } };
}

async function populate(f: Awaited<ReturnType<typeof fixture>>) {
  const devices = new DevicesService(f.db), care = new CareService(f.db), notifications = new NotificationService(f.db);
  const device = await provisionDevice(f.db, { serial_no: 'EXPORT-BOUND' });
  await devices.claim(f.owner.user.id, { ...device, pet_id: f.pet.id });
  await new FencesService(f.db).create(f.owner.user.id, { pet_id: f.pet.id, name: 'Export safe area', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
  const telemetry = new TelemetryService(f.db, devices, notifications);
  await telemetry.ingest({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'export-fixture', seq: 1,
    event_type: 'location.reported', device_ts: f.db.now(), source_metadata: { private: 'RAW-VENDOR-EXPORT-SECRET' },
    payload: { lat: 31.23, lon: 121.47, accuracy_m: 5, source: 'gnss', battery_pct: 5, signal: { private: 'RAW-SIGNAL-EXPORT-SECRET' } } }, device.device_token);
  await telemetry.work();
  const record = await care.create(f.owner.user.id, { pet_id: f.pet.id, type: 'note', value: { text: 'export-business-value' }, notes: 'export-business-note', recorded_at: f.db.now(), source: 'owner' });
  await care.update(f.owner.user.id, record.id, { notes: 'export-business-note-updated' });
  await notifications.registerToken(f.owner.user.id, { platform: 'android', token: 'EXPORT-PUSH-PRIVATE-TOKEN' });
  await notifications.registerToken(f.viewer.user.id, { platform: 'ios', token: 'VIEWER-PUSH-PRIVATE-TOKEN' });
  await notifications.updatePreferences(f.owner.user.id, { battery: false });
  await new ReportingService(f.db).lostMode(f.owner.user.id, device.device_id, { enabled: true });
  const share = await new SharesService(f.db).create(f.owner.user.id, f.pet.id, { consent: true });
  await new SupportService(f.db).create(f.owner.user.id, { device_id: device.device_id, category: 'other', description: 'owner-export-ticket', diagnostics_consent: true });
  await new SupportService(f.db).create(f.viewer.user.id, { device_id: device.device_id, category: 'other', description: 'viewer-private-ticket', diagnostics_consent: true });
  const sparePet = await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'Unbound owned device pet' });
  const spare = await provisionDevice(f.db, { serial_no: 'EXPORT-OWNED-UNBOUND' });
  await devices.claim(f.owner.user.id, { ...spare, pet_id: sparePet.id });
  const renewed = await devices.unbind(f.owner.user.id, spare.device_id);
  return { device, spare, renewed, share };
}

async function allPages(exporter: AccountExportService, user: string, section: string, household?: string, snapshot?: string) {
  const rows: Row[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await exporter.page(user, section, { household_id: household, limit: 2, cursor, snapshot_at: snapshot });
    assert.equal(page.section, section); assert.equal(page.household_id, household ?? null);
    rows.push(...page.items);
    cursor = page.next_cursor ?? undefined;
    if (cursor) { assert.ok(!cursors.has(cursor), 'Export cursor repeated'); cursors.add(cursor); }
    assert.ok(cursors.size < 100, 'Export pagination did not finish');
  } while (cursor);
  return rows;
}

function assertPrivateKeysAbsent(value: unknown) {
  const privateKeys = new Set(['password_hash', 'access_hash', 'refresh_hash', 'secret_hash', 'claim_hash', 'token_hash', 'payload_json', 'envelope_json', 'signal_json', 'raw_metrics_json', 'diagnostics_json']);
  if (Array.isArray(value)) { for (const item of value) assertPrivateKeysAbsent(item); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) { assert.ok(!privateKeys.has(key), `Private column leaked: ${key}`); assertPrivateKeysAbsent(item); }
}

test('导出清单与所有分页按白名单返回业务数据，秘密和原始遥测不泄漏，除一次审计外不改变源数据', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const seeded = await populate(f);
  const before: Record<string, number> = {};
  for (const table of tables) before[table] = (await f.db.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
  const manifest = await f.exporter.manifest(f.owner.user.id);
  assert.equal(manifest.format, 'doogy-account-export-v1');
  assert.equal(manifest.consistency, 'paged_current_authorization_not_database_snapshot');
  assert.equal(manifest.user.id, f.owner.user.id);
  assert.deepEqual(manifest.households.map((row: Row) => row.id), [f.owner.household.id]);
  assert.ok(manifest.personal_sections.includes('profile')); assert.ok(manifest.excluded.length > 0);
  const exported: Row = { manifest, personal: {}, family: {} };
  for (const section of manifest.personal_sections) exported.personal[section] = await allPages(f.exporter, f.owner.user.id, section, undefined, manifest.generated_at);
  for (const household of manifest.households) for (const section of household.sections) exported.family[section] = await allPages(f.exporter, f.owner.user.id, section, household.id, manifest.generated_at);
  assert.equal(exported.family.locations[0].lat, 31.23);
  assert.deepEqual(exported.family.locations[0].quality_flags, []);
  assert.equal(exported.family.care_records[0].value.text, 'export-business-value');
  assert.equal(exported.family.care_record_revisions.length, 1);
  assert.equal(exported.personal.owned_devices.length, 2);
  assert.equal(exported.personal.support_tickets.length, 1); assert.equal(exported.personal.support_tickets[0].description, 'owner-export-ticket');
  assertPrivateKeysAbsent(exported);
  const session = (await f.db.get('SELECT * FROM sessions WHERE user_id=?', f.owner.user.id))!;
  const user = (await f.db.get('SELECT * FROM users WHERE id=?', f.owner.user.id))!;
  const text = JSON.stringify(exported);
  for (const secret of [f.owner.access_token, f.owner.refresh_token, user.password_hash, session.access_hash, session.refresh_hash,
    seeded.device.device_token, digest(seeded.device.device_token), seeded.renewed.claim_code, digest(seeded.renewed.claim_code), seeded.share.token, digest(seeded.share.token),
    f.invitation.token, 'EXPORT-PUSH-PRIVATE-TOKEN', 'VIEWER-PUSH-PRIVATE-TOKEN', 'RAW-SIGNAL-EXPORT-SECRET', 'RAW-VENDOR-EXPORT-SECRET']) assert.ok(!text.includes(secret), 'A known private fixture value leaked');
  assert.ok(!text.includes('viewer-private-ticket'));
  for (const table of tables) assert.equal((await f.db.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n, before[table] + (table === 'audit_logs' ? 1 : 0), table);
  const audit = (await f.db.get("SELECT * FROM audit_logs WHERE action='account.export.requested'"))!;
  assert.equal(audit.actor_id, f.owner.user.id); assert.equal(audit.resource_id, f.owner.user.id);
});

test('导出分页无重复并固定cutoff，后续创建且排序靠后的记录不会混入当前导出', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  for (const suffix of ['000000000001', '000000000002', '000000000003']) await f.db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)',
    `00000000-0000-4000-8000-${suffix}`, f.owner.household.id, `Existing ${suffix}`, 'dog', null, null, null, f.db.now(), f.db.now());
  const first = await f.exporter.page(f.owner.user.id, 'pets', { household_id: f.owner.household.id, limit: 1 });
  assert.ok(first.next_cursor); f.advance(1000);
  const future = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  await f.db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)', future, f.owner.household.id, 'Created after export cutoff', 'dog', null, null, null, f.db.now(), f.db.now());
  const ids = first.items.map((row: Row) => row.id);
  let cursor = first.next_cursor;
  while (cursor) {
    const next = await f.exporter.page(f.owner.user.id, 'pets', { household_id: f.owner.household.id, limit: 1, cursor });
    assert.equal(next.generated_at, first.generated_at); ids.push(...next.items.map((row: Row) => row.id)); cursor = next.next_cursor;
    assert.ok(ids.length < 10);
  }
  assert.equal(ids.length, 4); assert.equal(new Set(ids).size, 4); assert.ok(!ids.includes(future));
  const later = await allPages(f.exporter, f.owner.user.id, 'pets', f.owner.household.id);
  assert.ok(later.some(row => row.id === future));
});

test('游标绑定用户、section、家庭和cutoff，跨范围与非法分页请求被拒绝', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'Another export pet' });
  const query = { household_id: f.owner.household.id, limit: 1 };
  const first = await f.exporter.page(f.owner.user.id, 'pets', query); assert.ok(first.next_cursor);
  await assert.rejects(f.exporter.page(f.owner.user.id, 'locations', { ...query, cursor: first.next_cursor }), status(400));
  await assert.rejects(f.exporter.page(f.viewer.user.id, 'pets', { ...query, cursor: first.next_cursor }), status(400));
  const invite = await f.identity.invite(f.outsider.user.id, f.outsider.household.id, { email: f.owner.user.email, role: 'viewer' });
  await f.identity.accept(f.owner.user.id, invite.token);
  await assert.rejects(f.exporter.page(f.owner.user.id, 'pets', { household_id: f.outsider.household.id, cursor: first.next_cursor }), status(400));
  await assert.rejects(f.exporter.page(f.owner.user.id, 'pets', { ...query, cursor: first.next_cursor, snapshot_at: '2026-11-17T05:00:00Z' }), status(400));
  await assert.rejects(f.exporter.page(f.owner.user.id, 'pets', { ...query, cursor: 'not-json-cursor' }), status(400));
  await assert.rejects(f.exporter.page(f.owner.user.id, 'missing-section', {}), status(404));
  await assert.rejects(f.exporter.page(f.owner.user.id, 'pets', {}), status(400));
  for (const limit of [0, 201, 'invalid']) await assert.rejects(f.exporter.page(f.owner.user.id, 'pets', { ...query, limit }));
  await assert.rejects(f.exporter.page(f.owner.user.id, 'profile', { snapshot_at: '2026-11-17T07:00:00Z' }), status(400));
});

test('每页重新授权，撤权后旧游标和清单不能恢复家庭访问', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'Shared second pet' });
  const first = await f.exporter.page(f.viewer.user.id, 'pets', { household_id: f.owner.household.id, limit: 1 }); assert.ok(first.next_cursor);
  await assert.rejects(f.exporter.page(f.outsider.user.id, 'pets', { household_id: f.owner.household.id }), status(404));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  await assert.rejects(f.exporter.page(f.viewer.user.id, 'pets', { household_id: f.owner.household.id, cursor: first.next_cursor }), status(404));
  const after = await f.exporter.manifest(f.viewer.user.id);
  assert.ok(!after.households.some((row: Row) => row.id === f.owner.household.id));
});

test('viewer清单和直接调用均不扩大分享授权元数据的原写权限', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await populate(f);
  const own = await f.exporter.manifest(f.owner.user.id), shared = await f.exporter.manifest(f.viewer.user.id);
  assert.ok(own.households.find((row: Row) => row.id === f.owner.household.id).sections.includes('location_shares'));
  assert.ok(!shared.households.find((row: Row) => row.id === f.owner.household.id).sections.includes('location_shares'));
  await assert.rejects(f.exporter.page(f.viewer.user.id, 'location_shares', { household_id: f.owner.household.id }), status(403));
  const locations = await f.exporter.page(f.viewer.user.id, 'locations', { household_id: f.owner.household.id });
  assert.equal(locations.items.length, 1); assert.equal(locations.items[0].lat, 31.23);
  const ownerTickets = await allPages(f.exporter, f.owner.user.id, 'support_tickets');
  const viewerTickets = await allPages(f.exporter, f.viewer.user.id, 'support_tickets');
  assert.equal(ownerTickets[0].description, 'owner-export-ticket'); assert.equal(viewerTickets[0].description, 'viewer-private-ticket');
  const ownerNotificationIds = (await f.db.all('SELECT id FROM notifications WHERE user_id=?', f.owner.user.id)).map(row => row.id).sort();
  const exportedIds = (await allPages(f.exporter, f.owner.user.id, 'notifications')).map(row => row.id).sort();
  assert.deepEqual(exportedIds, ownerNotificationIds);
});
