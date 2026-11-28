import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, TestContext } from 'node:test';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { CareService } from '../src/care';
import { PrivacyService } from '../src/privacy';
import { createManagedBackup, ManagedBackupOptions, previewManagedBackups } from '../scripts/managed-backups';

const password = 'Synthetic-managed-backup-2026';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function fixture(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'doogy-managed-backup-'));
  const source = join(folder, 'source.db'), db = new Db(source);
  const options: ManagedBackupOptions = { driver: 'sqlite', source, directory: join(folder, 'managed'), keepCount: 7, intervalHours: 24 };
  t.after(async () => {
    await db.close();
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    await rm(folder, { recursive: true, force: true });
  });
  const identity = new IdentityService(db), owner = await identity.register({ email: 'managed-owner@example.invalid', password });
  return { folder, source, db, options, identity, owner };
}

test('托管SQLite备份：零写预览、已提交WAL快照、完整清单和删除日志可独立核验', async t => {
  const f = await fixture(t);
  await f.db.exec('PRAGMA wal_autocheckpoint=0');
  const pet = await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'Erased synthetic pet' });
  await new PrivacyService(f.db).deletePet(f.owner.user.id, pet.id, { password, confirmation: pet.id });
  const keptPet = await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'Archived attachment pet' });
  const record = await new CareService(f.db).create(f.owner.user.id, { pet_id: keptPet.id, type: 'note', value: {}, recorded_at: f.db.now() });
  const attachmentId = f.db.id(), attachmentBytes = Buffer.from('%PDF-1.7\nManaged backup fixture\u0000\u00ff', 'utf8');
  await f.db.run('INSERT INTO care_attachments VALUES (?,?,?,?,?,?,?,?,?)', attachmentId, record.id, '合成记录.pdf', 'application/pdf',
    attachmentBytes.length, digest(attachmentBytes), attachmentBytes.toString('base64'), f.owner.user.id, f.db.now());
  assert.ok(existsSync(f.source + '-wal'));
  const before = await previewManagedBackups(f.options);
  assert.equal(before.backups.length, 0); assert.equal(existsSync(f.options.directory), false);
  const saved = await createManagedBackup(f.options);
  assert.equal(saved.status, 'completed'); assert.ok(saved.bundle);
  const bundle = saved.bundle!, manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
  assert.deepEqual(readdirSync(bundle).sort(), ['database.db','manifest.json','privacy-log.json']);
  assert.equal(manifest.format, 'doogy-managed-backup-v1'); assert.equal(manifest.verified, true);
  assert.equal(manifest.source_id, saved.source_id); assert.equal(manifest.driver, 'sqlite');
  assert.equal(manifest.id, basename(bundle));
  assert.deepEqual(manifest.files.map((file: any) => file.name).sort(), ['database.db','privacy-log.json']);
  for (const file of manifest.files) {
    const bytes = readFileSync(join(bundle, file.name));
    assert.equal(file.sha256, digest(bytes)); assert.equal(file.bytes, bytes.byteLength);
  }
  const log = JSON.parse(readFileSync(join(bundle, 'privacy-log.json'), 'utf8'));
  assert.equal(log.format, 'doogy-privacy-log-v1'); assert.equal(log.sha256, digest(JSON.stringify(log.receipts)));
  assert.deepEqual(log.receipts.map((row: any) => row.kind), ['pet']); assert.equal(log.receipts[0].resource_id, pet.id);
  for (const secret of [f.owner.user.email, password, f.owner.access_token, f.owner.refresh_token]) {
    assert.ok(!JSON.stringify({ manifest, log }).includes(secret));
  }
  await f.identity.register({ email: 'after-managed-backup@example.invalid', password });
  const recovered = new DatabaseSync(join(bundle, 'database.db'), { readOnly: true });
  try {
    assert.equal(recovered.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 1);
    assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM privacy_deletions').get()!.n, 1);
    const attachment = recovered.prepare('SELECT * FROM care_attachments WHERE id=?').get(attachmentId)!;
    assert.deepEqual({ ...attachment }, { ...await f.db.get('SELECT * FROM care_attachments WHERE id=?', attachmentId) });
    assert.deepEqual(Buffer.from(String(attachment.content_base64), 'base64'), attachmentBytes);
    assert.equal(attachment.sha256, digest(attachmentBytes));
  } finally { recovered.close(); }
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM users'))!.n, 2);
});

test('托管轮转仅在新备份成功后删除同源旧包，手工备份和其他源保留，失败不损失旧备份', async t => {
  const f = await fixture(t), options = { ...f.options, keepCount: 1 };
  const otherSource = join(f.folder, 'other.db'), other = new Db(otherSource);
  try {
    await new IdentityService(other).register({ email: 'other-managed@example.invalid', password });
    const foreign = await createManagedBackup({ ...options, source: otherSource });
    const manual = join(f.options.directory, 'manual-backup.db'); await writeFile(manual, 'Operator-owned manual backup');
    const first = await createManagedBackup(options);
    const plan = await previewManagedBackups(options);
    assert.ok(plan.delete_after_next_backup.includes(basename(first.bundle!)));
    assert.notEqual(first.source_id, foreign.source_id);
    const second = await createManagedBackup(options);
    assert.equal(second.status, 'completed'); assert.equal(second.removed.length, 1);
    assert.equal(existsSync(first.bundle!), false); assert.ok(existsSync(second.bundle!)); assert.ok(existsSync(foreign.bundle!));
    assert.equal(readFileSync(manual, 'utf8'), 'Operator-owned manual backup');
    const saved = readFileSync(join(second.bundle!, 'manifest.json'));
    await f.db.exec('PRAGMA foreign_keys=OFF');
    await f.db.run('INSERT INTO households VALUES (?,?,?,?)', 'invalid-household', 'Invalid fixture', 'missing-user', f.db.now());
    await assert.rejects(createManagedBackup(options));
    assert.deepEqual(readFileSync(join(second.bundle!, 'manifest.json')), saved);
    assert.ok(existsSync(foreign.bundle!)); assert.equal(readFileSync(manual, 'utf8'), 'Operator-owned manual backup');
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(createManagedBackup(options, { signal: aborted.signal }));
    assert.ok(existsSync(second.bundle!));
  } finally { await other.close(); }
});

test('损坏、额外文件和符号链接备份包不参与删除，不把修改过的目录当作本工具完整包', async t => {
  const f = await fixture(t);
  const linked = await createManagedBackup(f.options, { now: new Date('2026-11-17T06:00:00Z') });
  const extra = await createManagedBackup(f.options, { now: new Date('2026-11-17T06:01:00Z') });
  const damaged = await createManagedBackup(f.options, { now: new Date('2026-11-17T06:02:00Z') });
  const originalDatabase = readFileSync(join(damaged.bundle!, 'database.db'));
  writeFileSync(join(damaged.bundle!, 'database.db'), Buffer.concat([originalDatabase, Buffer.from('modified-after-backup')]));
  await writeFile(join(extra.bundle!, 'operator-note.txt'), 'Keep this user file');
  const link = join(dirname(linked.bundle!), randomUUID());
  await symlink(linked.bundle!, link, 'junction');
  const saved = await createManagedBackup({ ...f.options, keepCount: 2 });
  assert.equal(saved.status, 'completed'); assert.ok(existsSync(saved.bundle!));
  assert.ok(existsSync(damaged.bundle!)); assert.ok(existsSync(extra.bundle!));
  assert.ok(existsSync(linked.bundle!), 'A damaged recent package must not consume the valid-backup retention quota');
  assert.equal(readFileSync(join(extra.bundle!, 'operator-note.txt'), 'utf8'), 'Keep this user file');
  // A directory junction must not cause traversal into another bundle during rotation.
  assert.ok(readdirSync(dirname(link)).includes(basename(link)));
  assert.ok(saved.protected_entries.length >= 2);
});

test('托管备份跨连接锁、持久化到期判断和时钟倒退均不能误删本次成功备份', async t => {
  const f = await fixture(t), options = { ...f.options, keepCount: 1 };
  const now = new Date('2026-11-17T06:00:00.000Z');
  const first = await createManagedBackup(options, { scheduled: true, now });
  const notDue = await createManagedBackup(options, { scheduled: true, now: new Date(now.getTime() + 3600000) });
  assert.equal(notDue.status, 'skipped'); assert.equal(notDue.reason, 'not_due');
  const lock = new DatabaseSync(join(dirname(first.bundle!), '.lock.sqlite'));
  try {
    lock.exec('BEGIN IMMEDIATE');
    const busy = await createManagedBackup(options, { scheduled: true, now: new Date(now.getTime() + 25 * 3600000) });
    assert.equal(busy.status, 'skipped'); assert.equal(busy.reason, 'busy');
    assert.ok(existsSync(first.bundle!));
  } finally { lock.close(); }
  const rolledBackClock = await createManagedBackup(options, { now: new Date(now.getTime() - 3600000) });
  assert.equal(rolledBackClock.status, 'completed'); assert.ok(existsSync(rolledBackClock.bundle!));
  assert.equal(existsSync(first.bundle!), false);
});

test('旧SQLite源只读托管备份不自动迁移，缺失删除日志表以空日志显式兼容', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'doogy-managed-legacy-'));
  t.after(async () => {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    await rm(folder, { recursive: true, force: true });
  });
  const source = join(folder, 'legacy.db'), raw = new DatabaseSync(source);
  try {
    raw.exec('PRAGMA foreign_keys=ON; CREATE TABLE migrations(name TEXT PRIMARY KEY)');
    for (const name of readdirSync('db').filter(name => name.endsWith('.sql') && name <= '013-grant-lifecycle.sql').sort()) {
      raw.exec(readFileSync(join('db', name), 'utf8')); raw.prepare('INSERT INTO migrations VALUES (?)').run(name);
    }
  } finally { raw.close(); }
  const original = digest(readFileSync(source));
  const saved = await createManagedBackup({ driver: 'sqlite', source, directory: join(folder, 'managed'), keepCount: 1, intervalHours: 24 });
  assert.equal(digest(readFileSync(source)), original);
  const recovered = new DatabaseSync(join(saved.bundle!, 'database.db'), { readOnly: true });
  try { assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM migrations').get()!.n, 13); }
  finally { recovered.close(); }
  assert.deepEqual(JSON.parse(readFileSync(join(saved.bundle!, 'privacy-log.json'), 'utf8')).receipts, []);
});
