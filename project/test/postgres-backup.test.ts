import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Pool } from 'pg';
import { backupPostgres, restorePostgres } from '../scripts/postgres-backup';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { DevicesService, hash, provisionDevice } from '../src/devices';
import { DeviceCredentialsService } from '../src/device-credentials';
import { FencesService } from '../src/fences';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';
import { ReportingService } from '../src/reporting';
import { SharesService } from '../src/shares';
import { SupportService } from '../src/support';
import { CareService } from '../src/care';
import { dropFixtureDatabase } from './backend-fixture';
import { assistantTables, attachmentTables, behaviorTables, configurationTables, contactsTables, contentTables, healthTables, identityTables, inventoryTables, mediaTables, recoveryTables, tables, wellnessTables } from '../scripts/migrate-postgres';
import { ProfileService } from '../src/profile';
import { WellnessService } from '../src/wellness';
import { contentHealthTables, seedContentHealthData } from './content-health-fixture';
import { seedStage3Data, stage3Tables } from './stage3-fixture';
import { configurationContactTables, seedConfigurationContacts } from './configuration-contacts-fixture';
import { assertInterpretationFeedbackPreserved, seedInterpretationFeedback } from './interpretation-feedback-fixture';
import { assertPasswordRecoveryPreserved, seedPasswordRecoveryRequest } from './password-recovery-persistence-fixture';
import { assertContactAlertsPreserved, seedContactAlerts } from './contact-alerts-persistence-fixture';

const configured = process.env.TEST_DATABASE_URL;
const stamp = new Date();
const clock = () => stamp;
const databaseName = () => `doogy_backup_test_${randomUUID().replace(/-/g, '')}`;

async function fixture(work: (f: {
  db: Db; url: string; admin: Pool; archive: string; files: string[];
  targets: string[]; urlFor: (name: string) => string;
}) => Promise<void>) {
  const admin = new Pool({ connectionString: configured });
  const source = databaseName(), targets: string[] = [];
  const archive = resolve('data', `postgres-backup-test-${randomUUID()}.dump`), files = [archive, `${archive}.json`];
  const urlFor = (name: string) => { const url = new URL(configured!); url.pathname = `/${name}`; return url.toString(); };
  let db: Db | undefined, created = false;
  try {
    process.env.DATA_MODE = 'offline';
    await admin.query(`CREATE DATABASE "${source}"`); created = true;
    db = await Db.open({ driver: 'postgres', url: urlFor(source), clock });
    await work({ db, url: urlFor(source), admin, archive, files, targets, urlFor });
  } finally {
    try { if (db) await db.close(); }
    finally {
      try {
        for (const name of [...targets, ...(created ? [source] : [])]) {
          assert.match(name, /^doogy_backup_test_[a-f0-9]{32}$/);
          await dropFixtureDatabase(admin, name);
        }
      } finally {
        await admin.end();
        for (const file of files) try { unlinkSync(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
  }
}

async function seed(db: Db) {
  const identity = new IdentityService(db), devices = new DevicesService(db);
  const owner = await identity.register({ email: 'backup-owner@example.invalid', password: 'Synthetic-backup-2026' });
  const caregiver = await identity.register({ email: 'backup-caregiver@example.invalid', password: 'Synthetic-backup-2026' });
  const invite = await identity.invite(owner.user.id, owner.household.id, { email: caregiver.user.email, role: 'caregiver' });
  await identity.accept(caregiver.user.id, invite.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '恢复演练合成宠物' });
  const device = await provisionDevice(db, { serial_no: `BACKUP-${randomUUID()}` });
  await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
  const fence = await new FencesService(db).create(owner.user.id, { pet_id: pet.id, name: '恢复围栏',
    geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
  const telemetry = new TelemetryService(db, devices, new NotificationService(db));
  let seq = 0;
  const location = (seconds: number) => ({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
    boot_id: 'backup-boot', seq: seq++, device_ts: new Date(stamp.getTime() + seconds * 1000).toISOString(),
    event_type: 'location.reported', payload: { lat: 31.23, lon: 121.47, accuracy_m: 10, source: 'gnss', battery_pct: 80 } });
  await telemetry.ingest(location(-60), device.device_token);
  const activity = { schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'backup-activity', seq: 1,
    device_ts: db.now(), event_type: 'activity.reported', payload: {
      start_at: new Date(stamp.getTime() - 40_000).toISOString(), end_at: new Date(stamp.getTime() - 10_000).toISOString(),
      steps: 60, active_seconds: 20, signal: { network: 'synthetic-backup-network' },
    } };
  await telemetry.ingest(activity, device.device_token); await telemetry.work();
  await new ReportingService(db).lostMode(owner.user.id, device.device_id, { enabled: true });
  const share = await new SharesService(db).create(caregiver.user.id, pet.id, { consent: true });
  const ticket = await new SupportService(db).create(caregiver.user.id, { device_id: device.device_id,
    category: 'other', description: '恢复测试合成工单', diagnostics_consent: true });
  await telemetry.ingest(location(-5), device.device_token);
  return { identity, owner, caregiver, pet, device, fence, telemetry, location, share, ticket, activity };
}

test('PostgreSQL备份恢复：一致快照、原账号和队列、PostGIS及授权/活动触发器恢复可用', { skip: !configured, timeout: 90_000 }, async () => {
  await fixture(async f => {
    const seeded = await seed(f.db), target = databaseName(); f.targets.push(target);
    const unboundTicket = await new SupportService(f.db).create(seeded.owner.user.id, { category: 'binding', description: '恢复测试绑定前求助' });
    const closedEvents = [[f.db.id(), 'device_reconnected'], [f.db.id(), null]] as const;
    for (const [id, reason] of closedEvents) await f.db.run(`INSERT INTO safety_events
      (id,pet_id,device_id,type,occurred_at,details_json,status,closed_at,closed_reason) VALUES (?,?,?,?,?,?,'closed',?,?)`,
      id, seeded.pet.id, seeded.device.device_id, 'device.offline', f.db.now(), '{}', f.db.now(), reason);
    const care = new CareService(f.db);
    const toileting = await care.create(seeded.owner.user.id, { pet_id: seeded.pet.id, type: 'toileting', value: { kind: 'defecation', observation: '主人手记' }, recorded_at: f.db.now() });
    const custom = await care.create(seeded.owner.user.id, { pet_id: seeded.pet.id, type: 'custom', custom_type: '爪垫护理', value: { observation: '清洁后' }, recorded_at: f.db.now() });
    await care.update(seeded.owner.user.id, custom.id, { custom_type: '爪垫观察', value: { observation: '重新命名后' } });
    const attachmentBytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0xff,0x80]);
    const attachmentId = f.db.id(), attachmentHash = createHash('sha256').update(attachmentBytes).digest('hex');
    await f.db.run('INSERT INTO care_attachments VALUES (?,?,?,?,?,?,?,?,?)', attachmentId, custom.id, '备份照片.png', 'image/png',
      attachmentBytes.length, attachmentHash, attachmentBytes.toString('base64'), seeded.owner.user.id, f.db.now());
    const withdrawn = await care.create(seeded.owner.user.id, { pet_id: seeded.pet.id, type: 'note', value: { observation: 'original' }, recorded_at: f.db.now(), notes: 'Backup care note' });
    await care.update(seeded.owner.user.id, withdrawn.id, { value: { observation: 'corrected' } });
    await f.db.run('UPDATE care_records SET withdrawn_at=?,withdrawn_by=?,withdrawal_reason=? WHERE id=?', f.db.now(), seeded.owner.user.id, 'Synthetic backup withdrawal', withdrawn.id);
    const withdrawalId = f.db.id();
    await f.db.run('INSERT INTO privacy_deletions(id,kind,resource_id,deleted_at,payload_json) VALUES (?,?,?,?,?)', withdrawalId, 'care_withdrawal', withdrawn.id, f.db.now(), '{}');
    const credentials = new DeviceCredentialsService(f.db);
    const rotated = await credentials.rotate(seeded.owner.user.id, seeded.device.device_id, { reason: 'Verify rotated credential backup' });
    await credentials.revoke(seeded.owner.user.id, seeded.device.device_id, { reason: 'Verify revoked credential backup' });
    const savedCredential = (await f.db.get('SELECT secret_hash,credential_version,credential_status,credential_changed_at FROM devices WHERE id=?', seeded.device.device_id))!;
    assert.equal(savedCredential.secret_hash, hash(rotated.device_token));
    assert.equal(savedCredential.credential_version, 2); assert.equal(savedCredential.credential_status, 'revoked');
    const closedId = f.db.id(), deletionId = f.db.id();
    await f.db.run('INSERT INTO users(id,email,password_hash,created_at,closed_at) VALUES (?,?,?,?,?)', closedId, `${closedId}@closed.invalid`, 'unusable', f.db.now(), f.db.now());
    await f.db.run('INSERT INTO household_retention(household_id,enabled,telemetry_days,activity_days,safety_days,updated_at,last_run_at) VALUES (?,?,?,?,?,?,?)', seeded.owner.household.id, 1, 30, 180, 180, f.db.now(), f.db.now());
    await f.db.run('INSERT INTO privacy_deletions(id,kind,resource_id,deleted_at,payload_json) VALUES (?,?,?,?,?)', deletionId, 'account', closedId, f.db.now(), JSON.stringify({ owned_device_ids: [] }));
    await f.db.run('INSERT INTO inventory_retention(id,enabled,telemetry_days,updated_at,last_run_at) VALUES (?,?,?,?,?)', 'unassigned_telemetry', 1, 3, f.db.now(), f.db.now());
    const profile = new ProfileService(f.db), wellness = new WellnessService(f.db), date = f.db.now().slice(0, 10);
    await profile.update(seeded.owner.user.id, { expected_version: 0, display_name: 'Backup owner', consent: { terms_version: 'backup-t1', privacy_version: 'backup-p1', source: 'test' } });
    await profile.updateOnboarding(seeded.owner.user.id, { expected_version: 0, pet_id: seeded.pet.id, collar_choice: 'completed', completed: true });
    await profile.avatar(seeded.owner.user.id, seeded.pet.id, { expected_version: 0 }, { mimetype: 'image/png', buffer: attachmentBytes });
    for (const version of [0, 1]) {
      await wellness.putGoals(seeded.owner.user.id, seeded.pet.id, { effective_date: date, expected_version: version, targets: { active_minutes: 30 + version }, source: 'backup-user' });
      await wellness.putCheckIn(seeded.owner.user.id, seeded.pet.id, { date, timezone: 'UTC' }, { expected_version: version, values: { appetite: 'owner-described', energy: null } });
    }
    await seedContentHealthData(f.db, seeded.owner.user.id, seeded.pet.id);
    const stage3 = await seedStage3Data(f.db, seeded.owner.user.id, seeded.pet.id);
    await seedConfigurationContacts(f.db, seeded.owner.user.id, seeded.pet.id, seeded.owner.household.id);
    const interpretationFeedback = await seedInterpretationFeedback(f.db, seeded.owner.user.id, seeded.pet.id, stage3.media);
    const recoveryRequest = await seedPasswordRecoveryRequest(f.db, seeded.owner.user.id, seeded.owner.user.email);
    const contactAlert = await seedContactAlerts(f.db, seeded.owner.user.id, seeded.pet.id, seeded.owner.household.id);
    assert.equal((await f.db.get('SELECT signal_event_id FROM device_state WHERE device_id=?', seeded.device.device_id))!.signal_event_id, seeded.activity.event_id);
    const saved = await backupPostgres(f.url, f.archive);
    assert.equal(saved.verified, true);
    assert.equal(saved.tables.length, tables.length);
    assert.equal(saved.tables.find(row => row.table === 'care_attachments')!.rows, 1);
    assert.equal(readFileSync(f.archive).subarray(0, 5).toString(), 'PGDMP');
    assert.ok(existsSync(`${f.archive}.json`));
    await seeded.identity.register({ email: 'after-backup@example.invalid', password: 'Synthetic-backup-2026' });
    const restored = await restorePostgres(configured!, f.archive, target);
    assert.equal(restored.verified, true);
    const recovered = await Db.open({ driver: 'postgres', url: f.urlFor(target), clock });
    try {
      await assertInterpretationFeedbackPreserved(f.db, recovered, seeded.owner.user.id, seeded.pet.id, interpretationFeedback);
      await assertPasswordRecoveryPreserved(f.db, recovered, recoveryRequest);
      await assertContactAlertsPreserved(f.db, recovered, contactAlert);
      for (const table of ['user_profiles','user_consents','user_onboarding','pet_avatars','pet_goals','body_check_ins', ...contentHealthTables, ...stage3Tables, ...configurationContactTables]) {
        const order = table === 'user_profiles' || table === 'user_onboarding' ? 'user_id' : table === 'content_versions' ? 'content_id,version'
          : table === 'learning_progress' ? 'user_id,content_id,content_version' : table === 'health_observation_reads' ? 'user_id,observation_id' : 'id';
        assert.deepEqual(await recovered.all(`SELECT * FROM ${table} ORDER BY ${order}`), await f.db.all(`SELECT * FROM ${table} ORDER BY ${order}`), table);
      }
      assert.deepEqual(await new SupportService(recovered).detail(seeded.owner.user.id, unboundTicket.id),
        await new SupportService(f.db).detail(seeded.owner.user.id, unboundTicket.id));
      for (const [id, reason] of closedEvents) assert.deepEqual(await recovered.get('SELECT status,closed_at,closed_reason FROM safety_events WHERE id=?', id),
        { status: 'closed', closed_at: f.db.now(), closed_reason: reason });
      const attachment = (await recovered.get('SELECT * FROM care_attachments WHERE id=?', attachmentId))!;
      assert.deepEqual(attachment, await f.db.get('SELECT * FROM care_attachments WHERE id=?', attachmentId));
      assert.deepEqual(Buffer.from(attachment.content_base64, 'base64'), attachmentBytes);
      assert.equal(attachment.sha256, attachmentHash);
      assert.deepEqual(await recovered.get('SELECT * FROM users WHERE id=?', closedId), await f.db.get('SELECT * FROM users WHERE id=?', closedId));
      assert.deepEqual(await recovered.get('SELECT * FROM household_retention WHERE household_id=?', seeded.owner.household.id), await f.db.get('SELECT * FROM household_retention WHERE household_id=?', seeded.owner.household.id));
      assert.deepEqual(await recovered.get('SELECT * FROM privacy_deletions WHERE id=?', deletionId), await f.db.get('SELECT * FROM privacy_deletions WHERE id=?', deletionId));
      assert.deepEqual(await recovered.get('SELECT * FROM privacy_deletions WHERE id=?', withdrawalId), await f.db.get('SELECT * FROM privacy_deletions WHERE id=?', withdrawalId));
      assert.deepEqual(await recovered.get('SELECT * FROM care_records WHERE id=?', withdrawn.id), await f.db.get('SELECT * FROM care_records WHERE id=?', withdrawn.id));
      assert.deepEqual(await recovered.all('SELECT * FROM care_record_revisions WHERE record_id=? ORDER BY id', withdrawn.id), await f.db.all('SELECT * FROM care_record_revisions WHERE record_id=? ORDER BY id', withdrawn.id));
      for (const record of [toileting, custom]) {
        assert.deepEqual(await recovered.get('SELECT * FROM care_records WHERE id=?', record.id), await f.db.get('SELECT * FROM care_records WHERE id=?', record.id));
      }
      assert.equal((await recovered.get('SELECT custom_type FROM care_records WHERE id=?', custom.id))!.custom_type, '爪垫观察');
      assert.deepEqual(await recovered.all('SELECT * FROM care_record_revisions WHERE record_id=? ORDER BY id', custom.id), await f.db.all('SELECT * FROM care_record_revisions WHERE record_id=? ORDER BY id', custom.id));
      assert.deepEqual((await new CareService(recovered).list(seeded.owner.user.id, seeded.pet.id, { type: 'custom', custom_type: '爪垫观察' })).items.map((row: any) => row.id), [custom.id]);
      assert.equal((await new CareService(recovered).list(seeded.owner.user.id, seeded.pet.id, {})).items.some((row: any) => row.id === withdrawn.id), false);
      assert.deepEqual(await recovered.get('SELECT * FROM inventory_retention'), await f.db.get('SELECT * FROM inventory_retention'));
      assert.equal((await recovered.get('SELECT signal_event_id FROM device_state WHERE device_id=?', seeded.device.device_id))!.signal_event_id, seeded.activity.event_id);
      const identity = new IdentityService(recovered);
      assert.equal(await identity.userFromAccess(seeded.owner.access_token), seeded.owner.user.id);
      assert.equal((await identity.getPet(seeded.owner.user.id, seeded.pet.id)).name, seeded.pet.name);
      assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM users'))!.n, 3);
      assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM users'))!.n, 4);
      assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM migrations'))!.n, (await f.db.get('SELECT COUNT(*) AS n FROM migrations'))!.n);
      assert.deepEqual(await recovered.get('SELECT secret_hash,credential_version,credential_status,credential_changed_at FROM devices WHERE id=?', seeded.device.device_id), savedCredential);
      assert.equal(await recovered.fenceSide(seeded.fence, { lat: 31.23, lon: 121.47 }, 0), 'inside');
      assert.equal(await recovered.fenceSide(seeded.fence, { lat: 31.232, lon: 121.47 }, 0), 'outside');
      assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM locations WHERE __position IS NOT NULL'))!.n, 1);
      assert.equal((await recovered.all("SELECT indexname FROM pg_indexes WHERE tablename IN ('locations','geofences') AND indexdef ILIKE '%USING gist%'")).length, 2);
      const revision = (await recovered.get('SELECT revision FROM activity_versions WHERE pet_id=?', seeded.pet.id))!.revision;
      await recovered.run('UPDATE activity_samples SET steps=61 WHERE event_id=?', seeded.activity.event_id);
      assert.equal((await recovered.get('SELECT revision FROM activity_versions WHERE pet_id=?', seeded.pet.id))!.revision, revision + 1);
      await identity.revokeMember(seeded.owner.user.id, seeded.owner.household.id, seeded.caregiver.user.id);
      await assert.rejects(new SharesService(recovered).resolve(seeded.share.token));
      assert.equal((await recovered.get('SELECT diagnostics_json FROM support_tickets WHERE id=?', seeded.ticket.id))!.diagnostics_json, null);
      const worker = new TelemetryService(recovered, new DevicesService(recovered), new NotificationService(recovered));
      const nextLocation = seeded.location(0);
      for (const token of [seeded.device.device_token, rotated.device_token]) {
        await assert.rejects(worker.ingest(nextLocation, token), (error: unknown) => error instanceof HttpException && error.getStatus() === 401);
      }
      assert.equal(await worker.work(), 1);
      const active = await new DeviceCredentialsService(recovered).rotate(seeded.owner.user.id, seeded.device.device_id, { reason: 'Recover restored device credential' });
      assert.equal(active.credential.version, 3); assert.equal(active.credential.status, 'active');
      await worker.ingest(nextLocation, active.device_token);
      assert.equal(await worker.work(), 1);
      assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM locations'))!.n, 3);
      assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM device_events WHERE process_status='pending'"))!.n, 1);
      assert.deepEqual(await f.db.get('SELECT secret_hash,credential_version,credential_status,credential_changed_at FROM devices WHERE id=?', seeded.device.device_id), savedCredential);
    } finally { await recovered.close(); }
  });
});

test('PostgreSQL备份恢复：拒绝覆盖归档/已有空目标，缺失清单及损坏归档不创建目标', { skip: !configured, timeout: 90_000 }, async () => {
  await fixture(async f => {
    await new IdentityService(f.db).register({ email: 'keep-source@example.invalid', password: 'Synthetic-backup-2026' });
    await backupPostgres(f.url, f.archive);
    const original = readFileSync(f.archive), existing = databaseName(), rejected = databaseName(); f.targets.push(existing, rejected);
    await assert.rejects(backupPostgres(f.url, f.archive));
    assert.deepEqual(readFileSync(f.archive), original);
    await f.admin.query(`CREATE DATABASE "${existing}"`);
    await assert.rejects(restorePostgres(configured!, f.archive, existing));
    assert.equal((await f.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [existing])).rowCount, 1);
    const noManifest = `${f.archive}.missing`; f.files.push(noManifest);
    writeFileSync(noManifest, original);
    await assert.rejects(restorePostgres(configured!, noManifest, rejected));
    writeFileSync(f.archive, Buffer.concat([original, Buffer.from('changed')]));
    await assert.rejects(restorePostgres(configured!, f.archive, rejected));
    assert.equal((await f.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [rejected])).rowCount, 0);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM users'))!.n, 1);
  });
});

for (const legacy of [
  { cutoff: '010-care-attachments.sql', expected: inventoryTables },
  { cutoff: '013-profile-onboarding.sql', expected: attachmentTables },
  { cutoff: '014-wellness.sql', expected: identityTables },
  { cutoff: '015-content.sql', expected: wellnessTables },
  { cutoff: '016-health-observation-reads.sql', expected: contentTables },
  { cutoff: '017-media.sql', expected: healthTables },
  { cutoff: '018-behavior.sql', expected: mediaTables },
  { cutoff: '019-assistant.sql', expected: behaviorTables },
  { cutoff: '020-configuration-history.sql', expected: assistantTables },
  { cutoff: '021-household-contacts.sql', expected: configurationTables },
  { cutoff: '022-password-recovery.sql', expected: contactsTables },
  { cutoff: '023-contact-alerts.sql', expected: recoveryTables },
]) test(`PostgreSQL恢复：旧${legacy.expected.length}表归档按原清单验证，重开应用后应用剩余迁移`, { skip: !configured, timeout: 90_000 }, async () => {
  await fixture(async f => {
    const owner = await new IdentityService(f.db).register({ email: 'legacy-backup@example.invalid', password: 'Synthetic-backup-2026' });
    const saved = await backupPostgres(f.url, f.archive), target = databaseName(); f.targets.push(target);
    for (const table of tables.filter(table => !legacy.expected.includes(table)).reverse()) await f.db.exec(`DROP TABLE ${table}`);
    if (legacy.cutoff <= '016-health-observation-reads.sql') await f.db.exec('ALTER TABLE activity_observations DROP COLUMN __sequence');
    if (legacy.cutoff === '010-care-attachments.sql') {
      await f.db.exec('ALTER TABLE safety_events DROP COLUMN closed_reason');
      await f.db.exec(`ALTER TABLE support_tickets DROP CONSTRAINT support_ticket_binding_context,
        ALTER COLUMN device_id SET NOT NULL, ALTER COLUMN pet_id SET NOT NULL, ALTER COLUMN binding_id SET NOT NULL`);
    }
    await f.db.run('DELETE FROM migrations WHERE name>=?', legacy.cutoff);
    const url = new URL(f.url), env = { ...process.env, PGPASSWORD: url.password ? decodeURIComponent(url.password) : url.searchParams.get('password') ?? '', PGCONNECT_TIMEOUT: '10' };
    url.password = ''; url.searchParams.delete('password');
    let command = 'pg_dump', args: string[] = [];
    if ((process.env.PG_TOOLS ?? 'docker') === 'docker') {
      url.hostname = '127.0.0.1'; url.port = '5432';
      command = 'docker'; args = ['compose', '-f', resolve('compose.postgres.yml'), 'exec', '-T', '-e', 'PGPASSWORD', 'postgres', 'pg_dump'];
    }
    const archive = execFileSync(command, [...args, `--dbname=${url}`, '--format=custom', '--no-owner', '--no-privileges'], { env, windowsHide: true });
    writeFileSync(f.archive, archive);
    const manifest = { ...saved, migrations: saved.migrations.filter(name => name < legacy.cutoff),
      tables: saved.tables.filter(row => legacy.expected.includes(row.table)), archive_sha256: createHash('sha256').update(archive).digest('hex') };
    writeFileSync(`${f.archive}.json`, JSON.stringify(manifest));
    const restored = await restorePostgres(configured!, f.archive, target);
    assert.equal(restored.verified, true); assert.equal(restored.tables.length, legacy.expected.length);
    assert.deepEqual(restored.migrations, manifest.migrations);
    const recovered = await Db.open({ driver: 'postgres', url: f.urlFor(target), clock });
    try {
      assert.equal(await new IdentityService(recovered).userFromAccess(owner.access_token), owner.user.id);
      assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM care_attachments'))!.n, 0);
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '010-care-attachments.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '011-support-binding-help.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '012-safety-close-reason.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '013-profile-onboarding.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '014-wellness.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '015-content.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '016-health-observation-reads.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '017-media.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '018-behavior.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '019-assistant.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '020-configuration-history.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '021-household-contacts.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '022-password-recovery.sql'));
      assert.ok(await recovered.get('SELECT name FROM migrations WHERE name=?', '023-contact-alerts.sql'));
      for (const table of tables.filter(table => !legacy.expected.includes(table))) assert.equal((await recovered.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n, 0);
    } finally { await recovered.close(); }
  });
});

test('PostgreSQL恢复：内容核验或归档执行失败清理本次新库，保留原源库', { skip: !configured, timeout: 90_000 }, async () => {
  await fixture(async f => {
    await new IdentityService(f.db).register({ email: 'verify-source@example.invalid', password: 'Synthetic-backup-2026' });
    await backupPostgres(f.url, f.archive);
    const target = databaseName(); f.targets.push(target);
    const original = readFileSync(f.archive), originalManifest = readFileSync(`${f.archive}.json`, 'utf8');
    const manifest = JSON.parse(originalManifest);
    const users = manifest.tables.find((table: { table: string }) => table.table === 'users');
    assert.ok(users);
    users.sha256 = '0'.repeat(64);
    writeFileSync(`${f.archive}.json`, JSON.stringify(manifest));
    await assert.rejects(restorePostgres(configured!, f.archive, target));
    assert.equal((await f.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [target])).rowCount, 0);
    assert.deepEqual(readFileSync(f.archive), original);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM users'))!.n, 1);
    const truncated = original.subarray(0, original.length - 20), corruptManifest = JSON.parse(originalManifest);
    corruptManifest.archive_sha256 = createHash('sha256').update(truncated).digest('hex');
    writeFileSync(f.archive, truncated);
    writeFileSync(`${f.archive}.json`, JSON.stringify(corruptManifest));
    await assert.rejects(restorePostgres(configured!, f.archive, target));
    assert.equal((await f.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [target])).rowCount, 0);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM users'))!.n, 1);
  });
});
