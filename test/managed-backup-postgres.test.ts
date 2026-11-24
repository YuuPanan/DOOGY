import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createManagedBackup, ManagedBackupOptions, previewManagedBackups } from '../scripts/managed-backups';
import { restorePostgres } from '../scripts/postgres-backup';
import { privacyMaintenance } from '../scripts/privacy-maintenance';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { CareService } from '../src/care';
import { FencesService } from '../src/fences';
import { PrivacyService } from '../src/privacy';
import { dropFixtureDatabase } from './backend-fixture';

const configured = process.env.TEST_DATABASE_URL;
const databaseName = () => `doogy_backup_test_${randomUUID().replace(/-/g, '')}`;

test('PostgreSQL托管包：原生归档可恢复、PostGIS及删除日志保持，最新日志重放后再轮转不影响源库', { skip: !configured, timeout: 90000 }, async () => {
  process.env.DATA_MODE = 'offline';
  const folder = await mkdtemp(join(tmpdir(), 'doogy-managed-postgres-'));
  const admin = new Pool({ connectionString: configured }), source = databaseName(), restoredName = databaseName();
  const urlFor = (name: string) => { const url = new URL(configured!); url.pathname = `/${name}`; return url.toString(); };
  let db: Db | undefined, recovered: Db | undefined, sourceCreated = false, restoredCreated = false;
  try {
    await admin.query(`CREATE DATABASE "${source}"`); sourceCreated = true;
    db = await Db.open({ driver: 'postgres', url: urlFor(source) });
    const password = 'Synthetic-managed-postgres-2026', identity = new IdentityService(db);
    const owner = await identity.register({ email: 'managed-pg-owner@example.invalid', password });
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Managed PG live pet' });
    const record = await new CareService(db).create(owner.user.id, { pet_id: pet.id, type: 'note', value: {}, recorded_at: db.now() });
    const attachmentId = db.id(), attachmentBytes = Buffer.from('%PDF-1.7\nManaged PostgreSQL fixture\u0000\u00ff', 'utf8');
    const attachmentHash = createHash('sha256').update(attachmentBytes).digest('hex');
    await db.run('INSERT INTO care_attachments VALUES (?,?,?,?,?,?,?,?,?)', attachmentId, record.id, '恢复记录.pdf', 'application/pdf',
      attachmentBytes.length, attachmentHash, attachmentBytes.toString('base64'), owner.user.id, db.now());
    const discarded = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Already deleted pet' });
    await new PrivacyService(db).deletePet(owner.user.id, discarded.id, { password, confirmation: discarded.id });
    const fence = await new FencesService(db).create(owner.user.id, { pet_id: pet.id, name: 'Managed PG circle', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
    const options: ManagedBackupOptions = { driver: 'postgres', source: urlFor(source), directory: join(folder, 'managed'), keepCount: 1, intervalHours: 24 };
    const first = await createManagedBackup(options);
    assert.equal(first.status, 'completed'); assert.ok(first.bundle);
    const archive = join(first.bundle!, 'database.dump');
    assert.equal(readFileSync(archive).subarray(0, 5).toString(), 'PGDMP');
    const manifest = JSON.parse(readFileSync(join(first.bundle!, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files.map((file: any) => file.name).sort(), ['database.dump','database.dump.json','privacy-log.json']);
    for (const file of manifest.files) {
      const data: Buffer = readFileSync(join(first.bundle!, file.name));
      assert.equal(file.sha256, createHash('sha256').update(data).digest('hex')); assert.equal(file.bytes, data.byteLength);
    }
    const log = JSON.parse(readFileSync(join(first.bundle!, 'privacy-log.json'), 'utf8'));
    assert.equal(log.receipts.length, 1); assert.equal(log.receipts[0].resource_id, discarded.id);
    const credentialChanged = new URL(options.source); credentialChanged.password = 'changed-synthetic-password';
    assert.equal((await previewManagedBackups({ ...options, source: credentialChanged.toString() })).source_id, first.source_id);
    const otherDatabase = await previewManagedBackups({ ...options, source: urlFor(restoredName) });
    assert.notEqual(otherDatabase.source_id, first.source_id); assert.equal(otherDatabase.backups.length, 0);
    for (const privateValue of [password, owner.user.email, owner.access_token, owner.refresh_token, configured!]) {
      assert.ok(!JSON.stringify({ manifest, log }).includes(privateValue), 'Private credential leaked into managed metadata');
    }
    const restored = await restorePostgres(configured!, archive, restoredName); restoredCreated = true;
    assert.equal(restored.verified, true);
    recovered = await Db.open({ driver: 'postgres', url: urlFor(restoredName) });
    assert.equal(await new IdentityService(recovered).userFromAccess(owner.access_token), owner.user.id);
    assert.equal((await recovered.get('SELECT name FROM pets WHERE id=?', pet.id))!.name, pet.name);
    assert.equal(await recovered.fenceSide(fence, { lat: 31.23, lon: 121.47 }, 0), 'inside');
    assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM privacy_deletions'))!.n, 1);
    const attachment = (await recovered.get('SELECT * FROM care_attachments WHERE id=?', attachmentId))!;
    assert.deepEqual(attachment, await db.get('SELECT * FROM care_attachments WHERE id=?', attachmentId));
    assert.deepEqual(Buffer.from(attachment.content_base64, 'base64'), attachmentBytes);
    assert.equal(attachment.sha256, attachmentHash);
    await new PrivacyService(db).deletePet(owner.user.id, pet.id, { password, confirmation: pet.id });
    const latest = join(folder, 'latest-deletions.json'); await privacyMaintenance(db, 'export-log', latest);
    assert.equal((await privacyMaintenance(recovered, 'replay-log', latest)).applied, 1);
    assert.equal(await recovered.get('SELECT id FROM pets WHERE id=?', pet.id), undefined);
    assert.equal(await recovered.get('SELECT id FROM care_attachments WHERE id=?', attachmentId), undefined);
    assert.equal((await privacyMaintenance(recovered, 'replay-log', latest)).applied, 0);
    const second = await createManagedBackup(options);
    assert.equal(second.status, 'completed'); assert.ok(existsSync(second.bundle!)); assert.equal(existsSync(first.bundle!), false);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM users'))!.n, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM privacy_deletions'))!.n, 2);
  } finally {
    try { if (recovered) await recovered.close(); if (db) await db.close(); }
    finally {
      try {
        if (restoredCreated) await dropFixtureDatabase(admin, restoredName);
        if (sourceCreated) await dropFixtureDatabase(admin, source);
      } finally {
        await admin.end();
        assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
        await rm(folder, { recursive: true, force: true });
      }
    }
  }
});
