import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { DevicesService, provisionDevice } from '../src/devices';
import { FencesService } from '../src/fences';
import { TelemetryService } from '../src/telemetry';
import { NotificationService } from '../src/notifications';
import { CareService } from '../src/care';
import { ReportingService } from '../src/reporting';
import { SharesService } from '../src/shares';
import { SupportService } from '../src/support';
import { ObservationsService } from '../src/observations';
import { migrateSqliteToPostgres, tables } from '../scripts/migrate-postgres';
import { DeviceCredentialsService } from '../src/device-credentials';
import { dropFixtureDatabase } from './backend-fixture';
import { ProfileService } from '../src/profile';
import { WellnessService } from '../src/wellness';
import { contentHealthTables, seedContentHealthData } from './content-health-fixture';
import { seedStage3Data, stage3Tables } from './stage3-fixture';
import { configurationContactTables, seedConfigurationContacts } from './configuration-contacts-fixture';
import { assertInterpretationFeedbackPreserved, seedInterpretationFeedback } from './interpretation-feedback-fixture';
import { assertPasswordRecoveryPreserved, seedPasswordRecoveryRequest } from './password-recovery-persistence-fixture';
import { assertContactAlertsPreserved, seedContactAlerts } from './contact-alerts-persistence-fixture';

const testUrl = process.env.TEST_DATABASE_URL;
const clock = () => new Date('2026-11-17T06:00:00Z');

async function withPostgres(work: (db: Db, url: string) => Promise<void>) {
  process.env.DATA_MODE = 'offline';
  const admin = new Pool({ connectionString: testUrl });
  const name = `doogy_test_${randomUUID().replace(/-/g, '')}`;
  const url = new URL(testUrl!); url.pathname = `/${name}`;
  let db: Db | undefined, created = false;
  try {
    assert.match(name, /^doogy_test_[a-f0-9]{32}$/);
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    db = await Db.open({ driver: 'postgres', url: url.toString(), clock });
    await work(db, url.toString());
  } finally {
    if (db) await db.close();
    if (created) await dropFixtureDatabase(admin, name);
    await admin.end();
  }
}

async function seed(db: Db) {
  const identity = new IdentityService(db), devices = new DevicesService(db);
  const owner = await identity.register({ email: 'postgres-owner@example.invalid', password: 'Synthetic-postgres-2026', timezone: 'UTC' });
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'PostgreSQL 合成宠物' });
  const device = await provisionDevice(db, { serial_no: `PG-${randomUUID()}` });
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  const notifications = new NotificationService(db), telemetry = new TelemetryService(db, devices, notifications);
  const fences = new FencesService(db), care = new CareService(db);
  const fence = await fences.create(owner.user.id, { pet_id: pet.id, name: 'PostGIS circle', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } }) as Row;
  let seq = 0;
  const event = (lat: number, seconds: number) => ({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
    boot_id: 'postgres-boot', seq: seq++, device_ts: new Date(clock().getTime() + seconds * 1000).toISOString(), event_type: 'location.reported',
    payload: { lat, lon: 121.47, accuracy_m: 10, source: 'gnss', battery_pct: 15 } });
  return { identity, devices, owner, pet, device, notifications, telemetry, fences, fence, care, event };
}

test('PostgreSQL/PostGIS：实际空间计算、幂等、双连接队列及通知闭环', { skip: !testUrl }, async () => {
  await withPostgres(async (db, url) => {
    const f = await seed(db);
    assert.ok((await db.get('SELECT postgis_version() AS version'))!.version);
    assert.equal(await db.fenceSide(f.fence, { lat: 31.23, lon: 121.47 }, 0), 'inside');
    assert.equal(await db.fenceSide(f.fence, { lat: 31.232, lon: 121.47 }, 0), 'outside');
    const polygon = await f.fences.create(f.owner.user.id, { pet_id: f.pet.id, name: 'PostGIS polygon', enabled: false,
      geometry: { type: 'polygon', coordinates: [[121.46,31.22],[121.48,31.22],[121.48,31.24],[121.46,31.24]] } });
    assert.equal(await db.fenceSide(polygon, { lat: 31.23, lon: 121.47 }, 0), 'inside');
    assert.equal(await db.fenceSide(polygon, { lat: 31.22, lon: 121.46 }, 0), 'inside');
    assert.equal(await db.fenceSide(polygon, { lat: 31.22, lon: 121.46 }, 10), 'uncertain');
    const indices = await db.all("SELECT indexdef FROM pg_indexes WHERE tablename IN ('locations','geofences')");
    assert.ok(indices.filter(row => /USING gist/i.test(row.indexdef)).length >= 2);
    const events = [[31.23,-120],[31.232,-90],[31.232,-60],[31.23,-30],[31.23,0]].map(([lat, seconds]) => f.event(lat, seconds));
    for (const event of events) await f.telemetry.ingest(event, f.device.device_token);
    const secondDb = await Db.open({ driver: 'postgres', url, clock });
    try {
      const secondNotifications = new NotificationService(secondDb);
      const secondWorker = new TelemetryService(secondDb, new DevicesService(secondDb), secondNotifications);
      const processed = await Promise.all([f.telemetry.work(), secondWorker.work()]);
      assert.equal(processed.reduce((a, b) => a + b, 0), 5);
      await Promise.all([f.notifications.dispatch(), secondNotifications.dispatch()]);
    } finally { await secondDb.close(); }
    assert.equal((await f.telemetry.ingest(events[1], f.device.device_token)).duplicate, true);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM locations'))!.n), 5);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM safety_events'))!.n), 3);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM notifications WHERE status='simulated'"))!.n), 3);
    assert.equal((await db.get('SELECT status FROM geofence_states WHERE fence_id=?', f.fence.id))!.status, 'inside');
    const input = { household_id: f.owner.household.id, name: 'idem' };
    const pets = await Promise.all([f.identity.createPet(f.owner.user.id, input, 'pg-key'), f.identity.createPet(f.owner.user.id, input, 'pg-key')]);
    assert.equal(pets[0].id, pets[1].id);
    await assert.rejects(db.transaction(async () => { await db.audit(null, 'pg.rollback', 'x'); throw new Error('rollback'); }), /rollback/);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='pg.rollback'"))!.n), 0);
  });
});

test('PostgreSQL：活动版本触发器与撤权触发器保留 SQLite 语义', { skip: !testUrl }, async () => {
  await withPostgres(async db => {
    const f = await seed(db);
    const before = await f.care.daily(f.owner.user.id, f.pet.id, { date: '2026-11-17' });
    const activity = { schema_version: '1.0', event_id: randomUUID(), device_id: f.device.device_id, boot_id: 'activity', seq: 1,
      device_ts: db.now(), event_type: 'activity.reported', payload: { start_at: '2026-11-17T05:40:00Z', end_at: '2026-11-17T05:50:00Z', steps: 600, active_seconds: 300 } };
    await f.telemetry.ingest(activity, f.device.device_token); await f.telemetry.work();
    const after = await f.care.daily(f.owner.user.id, f.pet.id, { date: '2026-11-17' });
    assert.equal(after.steps, 600); assert.ok(after.source_revision > before.source_revision);
    await db.run('UPDATE activity_samples SET steps=1200 WHERE event_id=?', activity.event_id);
    assert.equal((await f.care.daily(f.owner.user.id, f.pet.id, { date: '2026-11-17' })).steps, 1200);
    await db.run('DELETE FROM activity_samples WHERE event_id=?', activity.event_id);
    const deleted = await f.care.daily(f.owner.user.id, f.pet.id, { date: '2026-11-17' });
    assert.equal(deleted.steps, null); assert.ok(deleted.source_revision > after.source_revision);
    const caregiver = await f.identity.register({ email: 'postgres-care@example.invalid', password: 'Synthetic-postgres-2026' });
    const invite = await f.identity.invite(f.owner.user.id, f.owner.household.id, { email: caregiver.user.email, role: 'caregiver' });
    await f.identity.accept(caregiver.user.id, invite.token);
    await new ReportingService(db).lostMode(f.owner.user.id, f.device.device_id, { enabled: true });
    const shares = new SharesService(db), support = new SupportService(db);
    const share = await shares.create(caregiver.user.id, f.pet.id, { consent: true });
    const ticket = await support.create(caregiver.user.id, { device_id: f.device.device_id, category: 'other', description: 'synthetic', diagnostics_consent: true });
    await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id);
    await assert.rejects(shares.resolve(share.token));
    assert.equal((await db.get('SELECT diagnostics_json FROM support_tickets WHERE id=?', ticket.id))!.diagnostics_json, null);
    const again = await f.identity.invite(f.owner.user.id, f.owner.household.id, { email: caregiver.user.email, role: 'caregiver' });
    await f.identity.accept(caregiver.user.id, again.token);
    await assert.rejects(shares.resolve(share.token));
    const nextShare = await shares.create(caregiver.user.id, f.pet.id, { consent: true });
    const nextTicket = await support.create(caregiver.user.id, { device_id: f.device.device_id, category: 'other', description: 'new-consent', diagnostics_consent: true });
    await f.identity.changeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id, { role: 'viewer' });
    await assert.rejects(shares.resolve(nextShare.token));
    assert.ok((await db.get('SELECT diagnostics_json FROM support_tickets WHERE id=?', nextTicket.id))!.diagnostics_json);
    await f.identity.changeMember(f.owner.user.id, f.owner.household.id, caregiver.user.id, { role: 'caregiver' });
    await assert.rejects(shares.resolve(nextShare.token));
    const finalShare = await shares.create(caregiver.user.id, f.pet.id, { consent: true });
    await f.devices.unbind(f.owner.user.id, f.device.device_id);
    await assert.rejects(shares.resolve(finalShare.token));
    assert.equal((await db.get('SELECT diagnostics_json FROM support_tickets WHERE id=?', nextTicket.id))!.diagnostics_json, null);
  });
});

async function withSqlite(work: (db: Db, path: string) => Promise<void>) {
  const path = resolve('data', `pg-import-${randomUUID()}.db`), db = new Db(path, clock);
  try { await work(db, path); }
  finally {
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) try { unlinkSync(path + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

test('SQLite→PostgreSQL：整库逐字段核对，原身份/待处理队列保留，非空目标拒绝', { skip: !testUrl }, async () => {
  await withPostgres(async target => withSqlite(async (source, path) => {
    const f = await seed(source);
    const unboundTicket = await new SupportService(source).create(f.owner.user.id, { category: 'binding', description: '迁移测试绑定前求助' });
    const closedEvents = [[source.id(), 'location_recovered'], [source.id(), null]] as const;
    for (const [id, reason] of closedEvents) await source.run(`INSERT INTO safety_events
      (id,pet_id,device_id,type,occurred_at,details_json,status,closed_at,closed_reason) VALUES (?,?,?,?,?,?,'closed',?,?)`,
      id, f.pet.id, f.device.device_id, 'location.stale', source.now(), '{}', source.now(), reason);
    await f.care.create(f.owner.user.id, { pet_id: f.pet.id, type: 'weight', value: { weight_kg: 12 }, recorded_at: source.now() });
    const toileting = await f.care.create(f.owner.user.id, { pet_id: f.pet.id, type: 'toileting', value: { kind: 'both', observation: '主人手记' }, recorded_at: source.now() });
    const custom = await f.care.create(f.owner.user.id, { pet_id: f.pet.id, type: 'custom', custom_type: '爪垫护理', value: { observation: '清洁后' }, recorded_at: source.now() });
    await f.care.update(f.owner.user.id, custom.id, { custom_type: '爪垫观察', value: { observation: '重新命名后' } });
    const attachmentBytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0xff,0x80]);
    const attachmentId = source.id(), attachmentHash = createHash('sha256').update(attachmentBytes).digest('hex');
    await source.run('INSERT INTO care_attachments VALUES (?,?,?,?,?,?,?,?,?)', attachmentId, custom.id, '爪垫照片.png', 'image/png',
      attachmentBytes.length, attachmentHash, attachmentBytes.toString('base64'), f.owner.user.id, source.now());
    const profile = new ProfileService(source), wellness = new WellnessService(source);
    await profile.update(f.owner.user.id, { expected_version: 0, display_name: 'Imported owner', consent: { terms_version: 'import-t1', privacy_version: 'import-p1', source: 'test' } });
    await profile.updateOnboarding(f.owner.user.id, { expected_version: 0, pet_id: f.pet.id, collar_choice: 'completed', completed: true });
    await profile.avatar(f.owner.user.id, f.pet.id, { expected_version: 0 }, { mimetype: 'image/png', buffer: attachmentBytes });
    for (const version of [0, 1]) {
      await wellness.putGoals(f.owner.user.id, f.pet.id, { effective_date: '2026-11-17', expected_version: version, targets: { active_minutes: 30 + version }, source: 'import-user' });
      await wellness.putCheckIn(f.owner.user.id, f.pet.id, { date: '2026-11-17', timezone: 'UTC' }, { expected_version: version, values: { appetite: 'owner-described', energy: null } });
    }
    await seedContentHealthData(source, f.owner.user.id, f.pet.id);
    const withdrawn = await f.care.create(f.owner.user.id, { pet_id: f.pet.id, type: 'note', value: { observation: 'before correction' }, recorded_at: source.now(), notes: 'imported care history' });
    await f.care.update(f.owner.user.id, withdrawn.id, { value: { observation: 'corrected' }, notes: 'corrected before withdrawal' });
    await source.run('UPDATE care_records SET withdrawn_at=?,withdrawn_by=?,withdrawal_reason=? WHERE id=?', source.now(), f.owner.user.id, 'Synthetic migration withdrawal', withdrawn.id);
    const withdrawalId = source.id();
    await source.run('INSERT INTO privacy_deletions(id,kind,resource_id,deleted_at,payload_json) VALUES (?,?,?,?,?)', withdrawalId, 'care_withdrawal', withdrawn.id, source.now(), '{}');
    await f.telemetry.ingest({ schema_version: '1.0', event_id: randomUUID(), device_id: f.device.device_id, boot_id: 'import-activity', seq: 1,
      device_ts: source.now(), event_type: 'activity.reported', payload: { start_at: '2026-11-17T05:40:00Z', end_at: '2026-11-17T05:50:00Z', steps: 600, active_seconds: 300, signal: { network: 'synthetic-import-network' } } }, f.device.device_token);
    await f.telemetry.work();
    const originalDaily = await f.care.daily(f.owner.user.id, f.pet.id, { date: '2026-11-17' });
    await new ObservationsService(source, f.care).get(f.owner.user.id, f.pet.id, { date: '2026-11-16' });
    await f.telemetry.ingest(f.event(31.232, -30), f.device.device_token); await f.telemetry.work();
    await f.telemetry.ingest(f.event(31.232, 0), f.device.device_token);
    const credentials = new DeviceCredentialsService(source);
    await credentials.rotate(f.owner.user.id, f.device.device_id, { reason: 'Migration credential generation' });
    await credentials.revoke(f.owner.user.id, f.device.device_id, { reason: 'Preserve revoked state during migration' });
    const closedId = source.id(), deletedId = source.id();
    await source.run('INSERT INTO users(id,email,password_hash,created_at,closed_at) VALUES (?,?,?,?,?)', closedId, `${closedId}@closed.invalid`, 'unusable', source.now(), source.now());
    await source.run('INSERT INTO household_retention(household_id,enabled,telemetry_days,activity_days,safety_days,updated_at,last_run_at) VALUES (?,?,?,?,?,?,?)', f.owner.household.id, 1, 30, 180, 180, source.now(), source.now());
    await source.run('INSERT INTO privacy_deletions(id,kind,resource_id,deleted_at,payload_json) VALUES (?,?,?,?,?)', deletedId, 'account', closedId, source.now(), JSON.stringify({ owned_device_ids: [] }));
    await source.run('INSERT INTO inventory_retention(id,enabled,telemetry_days,updated_at,last_run_at) VALUES (?,?,?,?,?)', 'unassigned_telemetry', 1, 3, source.now(), source.now());
    const signalEventId = (await source.get('SELECT signal_event_id FROM device_state WHERE device_id=?', f.device.device_id))!.signal_event_id;
    assert.ok(signalEventId);
    const stage3 = await seedStage3Data(source, f.owner.user.id, f.pet.id);
    await seedConfigurationContacts(source, f.owner.user.id, f.pet.id, f.owner.household.id);
    const interpretationFeedback = await seedInterpretationFeedback(source, f.owner.user.id, f.pet.id, stage3.media);
    const recoveryRequest = await seedPasswordRecoveryRequest(source, f.owner.user.id, f.owner.user.email);
    const contactAlert = await seedContactAlerts(source, f.owner.user.id, f.pet.id, f.owner.household.id);
    const result = await migrateSqliteToPostgres(path, target);
    assert.equal(result.verified, true); assert.equal(result.tables.length, tables.length);
    await assertInterpretationFeedbackPreserved(source, target, f.owner.user.id, f.pet.id, interpretationFeedback);
    await assertPasswordRecoveryPreserved(source, target, recoveryRequest);
    await assertContactAlertsPreserved(source, target, contactAlert);
    for (const table of ['user_profiles','user_consents','user_onboarding','pet_avatars','pet_goals','body_check_ins', ...contentHealthTables, ...stage3Tables, ...configurationContactTables]) {
      const order = table === 'user_profiles' || table === 'user_onboarding' ? 'user_id' : table === 'content_versions' ? 'content_id,version'
        : table === 'learning_progress' ? 'user_id,content_id,content_version' : table === 'health_observation_reads' ? 'user_id,observation_id' : 'id';
      assert.deepEqual(await target.all(`SELECT * FROM ${table} ORDER BY ${order}`), (await source.all(`SELECT * FROM ${table} ORDER BY ${order}`)).map(row => ({ ...row })), table);
    }
    assert.deepEqual(await new SupportService(target).detail(f.owner.user.id, unboundTicket.id),
      await new SupportService(source).detail(f.owner.user.id, unboundTicket.id));
    for (const [id, reason] of closedEvents) assert.deepEqual(await target.get('SELECT status,closed_at,closed_reason FROM safety_events WHERE id=?', id),
      { status: 'closed', closed_at: source.now(), closed_reason: reason });
    const attachment = (await target.get('SELECT * FROM care_attachments WHERE id=?', attachmentId))!;
    assert.deepEqual(attachment, { ...await source.get('SELECT * FROM care_attachments WHERE id=?', attachmentId) });
    assert.deepEqual(Buffer.from(attachment.content_base64, 'base64'), attachmentBytes);
    assert.equal(attachment.sha256, attachmentHash);
    assert.deepEqual(await target.get('SELECT * FROM users WHERE id=?', closedId), { ...await source.get('SELECT * FROM users WHERE id=?', closedId) });
    assert.deepEqual(await target.get('SELECT * FROM household_retention WHERE household_id=?', f.owner.household.id), { ...await source.get('SELECT * FROM household_retention WHERE household_id=?', f.owner.household.id) });
    assert.deepEqual(await target.get('SELECT * FROM privacy_deletions WHERE id=?', deletedId), { ...await source.get('SELECT * FROM privacy_deletions WHERE id=?', deletedId) });
    assert.deepEqual(await target.get('SELECT * FROM privacy_deletions WHERE id=?', withdrawalId), { ...await source.get('SELECT * FROM privacy_deletions WHERE id=?', withdrawalId) });
    assert.deepEqual(await target.get('SELECT * FROM care_records WHERE id=?', withdrawn.id), { ...await source.get('SELECT * FROM care_records WHERE id=?', withdrawn.id) });
    assert.deepEqual(await target.all('SELECT * FROM care_record_revisions WHERE record_id=? ORDER BY id', withdrawn.id), (await source.all('SELECT * FROM care_record_revisions WHERE record_id=? ORDER BY id', withdrawn.id)).map(row => ({ ...row })));
    for (const record of [toileting, custom]) {
      assert.deepEqual(await target.get('SELECT * FROM care_records WHERE id=?', record.id), { ...await source.get('SELECT * FROM care_records WHERE id=?', record.id) });
    }
    assert.equal((await target.get('SELECT custom_type FROM care_records WHERE id=?', custom.id))!.custom_type, '爪垫观察');
    assert.deepEqual(await target.all('SELECT * FROM care_record_revisions WHERE record_id=? ORDER BY id', custom.id), (await source.all('SELECT * FROM care_record_revisions WHERE record_id=? ORDER BY id', custom.id)).map(row => ({ ...row })));
    assert.deepEqual((await new CareService(target).list(f.owner.user.id, f.pet.id, { type: 'custom', custom_type: '爪垫观察' })).items.map((row: Row) => row.id), [custom.id]);
    assert.equal((await new CareService(target).list(f.owner.user.id, f.pet.id, {})).items.some((row: Row) => row.id === withdrawn.id), false);
    assert.deepEqual(await target.get('SELECT * FROM inventory_retention'), { ...await source.get('SELECT * FROM inventory_retention') });
    assert.equal((await target.get('SELECT signal_event_id FROM device_state WHERE device_id=?', f.device.device_id))!.signal_event_id, signalEventId);
    assert.equal(await new IdentityService(target).userFromAccess(f.owner.access_token), f.owner.user.id);
    assert.equal((await new IdentityService(target).getPet(f.owner.user.id, f.pet.id)).weight_kg, 12);
    assert.deepEqual(await new CareService(target).daily(f.owner.user.id, f.pet.id, { date: '2026-11-17' }), originalDaily);
    const worker = new TelemetryService(target, new DevicesService(target), new NotificationService(target));
    const imported = await new DeviceCredentialsService(target).view(f.owner.user.id, f.device.device_id);
    assert.equal(imported.credential.version, 2); assert.equal(imported.credential.status, 'revoked');
    await assert.rejects(worker.ingest(f.event(31.23, 1), f.device.device_token), (error: any) => error.getStatus?.() === 401);
    assert.equal(await worker.work(), 1);
    assert.equal(Number((await target.get("SELECT COUNT(*) AS n FROM safety_events WHERE type='geofence.exited'"))!.n), 1);
    assert.equal(Number((await source.get("SELECT COUNT(*) AS n FROM device_events WHERE process_status='pending'"))!.n), 1);
    await assert.rejects(migrateSqliteToPostgres(path, target), /POSTGRES_TARGET_NOT_EMPTY/);
  }));
});

test('SQLite→PostgreSQL：旧013/015/016/018/019/020/032/033源库只读，缺失列保持NULL并完整保留照护修订', { skip: !testUrl }, async () => {
  for (const version of ['013', '015', '016', '018', '019', '020', '032', '033']) await withPostgres(async target => {
    const path = resolve('data', `pg-import-legacy-${randomUUID()}.db`), source = new DatabaseSync(path);
    const user = randomUUID(), household = randomUUID(), pet = randomUUID(), record = randomUUID(), revision = randomUUID(), device = randomUUID(), event = randomUUID(), now = clock().toISOString();
    try {
      source.exec('PRAGMA foreign_keys=ON; CREATE TABLE migrations(name TEXT PRIMARY KEY)');
      for (const file of readdirSync(resolve('db')).filter(name => name.endsWith('.sql') && name.slice(0, 3) <= version).sort()) {
        source.exec(readFileSync(resolve('db', file), 'utf8'));
        source.prepare('INSERT INTO migrations VALUES (?)').run(file);
      }
      source.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)').run(user, `legacy-${version}@example.invalid`, 'legacy-password-hash', now);
      source.prepare('INSERT INTO households VALUES (?,?,?,?)').run(household, 'Legacy import', user, now);
      source.prepare('INSERT INTO pets(id,household_id,name,species,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(pet, household, 'Legacy care pet', 'dog', now, now);
      source.prepare('INSERT INTO care_records(id,pet_id,type,value_json,recorded_at,source,notes,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(record, pet, 'note', '{"observation":"corrected"}', now, 'owner', 'Legacy care notes', user, now, now);
      source.prepare('INSERT INTO care_record_revisions VALUES (?,?,?,?,?)').run(revision, record, '{"value":{"observation":"original"},"notes":"Original legacy notes"}', user, now);
      source.prepare('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)').run(device, `legacy-${version}`, 'simulator', 'legacy', 'unused', now);
      source.prepare('INSERT INTO device_state(device_id,signal_json) VALUES (?,?)').run(device, '{"legacy":"signal"}');
      source.prepare(`INSERT INTO safety_events(id,pet_id,device_id,type,occurred_at,details_json,status,closed_at) VALUES (?,?,?,?,?,?,'closed',?)`)
        .run(event, pet, device, 'device.offline', now, '{}', now);
      const original = readFileSync(path);
      const result = await migrateSqliteToPostgres(path, target);
      assert.equal(result.tables.length, tables.length); assert.equal(result.total_rows, 8);
      assert.deepEqual(await target.get('SELECT status,closed_at,closed_reason FROM safety_events WHERE id=?', event),
        { status: 'closed', closed_at: now, closed_reason: null });
      assert.equal((await target.get('SELECT closed_at FROM users WHERE id=?', user))!.closed_at, null);
      const signal = (await target.get('SELECT signal_json,signal_event_id FROM device_state WHERE device_id=?', device))!;
      assert.equal(signal.signal_json, '{"legacy":"signal"}'); assert.equal(signal.signal_event_id, null);
      assert.deepEqual(await target.get('SELECT withdrawn_at,withdrawn_by,withdrawal_reason FROM care_records WHERE id=?', record), { withdrawn_at: null, withdrawn_by: null, withdrawal_reason: null });
      assert.equal((await target.get('SELECT custom_type FROM care_records WHERE id=?', record))!.custom_type, null);
      const importedCare = (await target.get('SELECT * FROM care_records WHERE id=?', record))!;
      for (const [key, value] of Object.entries(source.prepare('SELECT * FROM care_records WHERE id=?').get(record)!)) assert.equal(importedCare[key], value);
      assert.deepEqual(await target.get('SELECT * FROM care_record_revisions WHERE id=?', revision), { ...source.prepare('SELECT * FROM care_record_revisions WHERE id=?').get(revision) });
      for (const table of ['household_retention', 'privacy_deletions', 'inventory_retention', 'care_attachments', 'password_recovery_requests', 'contact_alerts', 'contact_alert_recipients']) assert.equal((await target.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n, 0);
      assert.deepEqual(readFileSync(path), original);
      assert.equal(source.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='inventory_retention'").get()!.n, version >= '018' ? 1 : 0);
      assert.equal(source.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='care_attachments'").get()!.n, version >= '021' ? 1 : 0);
      assert.equal(source.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='password_recovery_requests'").get()!.n, version >= '033' ? 1 : 0);
      for (const table of ['contact_alerts', 'contact_alert_recipients']) assert.equal(source.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table)!.n, 0);
    } finally { source.close(); unlinkSync(path); }
  });
});

test('SQLite→PostgreSQL：不合法空间数据使整次迁移回滚，原 SQLite 不变', { skip: !testUrl }, async () => {
  await withPostgres(async target => withSqlite(async (source, path) => {
    const f = await seed(source);
    await f.telemetry.ingest(f.event(31.23, 0), f.device.device_token); await f.telemetry.work();
    await source.run('UPDATE locations SET lat=100');
    await assert.rejects(migrateSqliteToPostgres(path, target));
    assert.equal(Number((await target.get('SELECT COUNT(*) AS n FROM users'))!.n), 0);
    assert.equal(Number((await target.get('SELECT COUNT(*) AS n FROM device_events'))!.n), 0);
    assert.equal((await source.get('SELECT lat FROM locations'))!.lat, 100);
  }));
});
