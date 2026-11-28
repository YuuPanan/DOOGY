import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../src/db';
import { snapshotDatabase } from '../scripts/database-snapshot';

function files() {
  const prefix = resolve('data', `backup-test-${randomUUID()}`);
  const names = ['source', 'snapshot', 'restored', 'bad', 'new'].map(name => `${prefix}-${name}.db`);
  return { names, cleanup: () => {
    for (const file of names) for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(file + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  } };
}

test('在线备份包含已提交WAL数据，恢复到新文件后可重开且原库保持独立', async () => {
  const { names: [source, snapshot, restored], cleanup } = files();
  const db = new Db(source);
  try {
    await db.exec('PRAGMA wal_autocheckpoint=0');
    await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', 'before', 'before@example.invalid', 'synthetic', db.now());
    await db.run('INSERT INTO households VALUES (?,?,?,?)', 'backup-home', 'Synthetic backup home', 'before', db.now());
    await db.run('INSERT INTO pets(id,household_id,name,species,created_at,updated_at) VALUES (?,?,?,?,?,?)', 'backup-pet', 'backup-home', 'Synthetic pet', 'dog', db.now(), db.now());
    await db.run('INSERT INTO care_records(id,pet_id,type,value_json,recorded_at,source,notes,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      'backup-care', 'backup-pet', 'note', '{}', db.now(), 'owner', 'Synthetic note', 'before', db.now(), db.now());
    const attachmentBytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0xff,0x80]);
    const attachmentHash = createHash('sha256').update(attachmentBytes).digest('hex');
    await db.run('INSERT INTO care_attachments VALUES (?,?,?,?,?,?,?,?,?)', 'backup-attachment', 'backup-care', '原生备份.png', 'image/png',
      attachmentBytes.length, attachmentHash, attachmentBytes.toString('base64'), 'before', db.now());
    assert.ok(existsSync(source + '-wal'));
    const saved = await snapshotDatabase(source, snapshot);
    assert.equal(saved.integrity, 'ok');
    assert.ok(saved.pages > 0);
    await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', 'after', 'after@example.invalid', 'synthetic', db.now());
    await snapshotDatabase(snapshot, restored);
    const recovered = new Db(restored);
    try {
      assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM users'))!.n, 1);
      assert.equal((await recovered.get('SELECT id FROM users'))!.id, 'before');
      assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM migrations'))!.n, (await db.get('SELECT COUNT(*) AS n FROM migrations'))!.n);
      const attachment = (await recovered.get('SELECT * FROM care_attachments WHERE id=?', 'backup-attachment'))!;
      assert.deepEqual({ ...attachment }, { ...await db.get('SELECT * FROM care_attachments WHERE id=?', 'backup-attachment') });
      assert.deepEqual(Buffer.from(attachment.content_base64, 'base64'), attachmentBytes);
      assert.equal(attachment.sha256, attachmentHash);
    } finally { await recovered.close(); }
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM users'))!.n, 2);
  } finally { await db.close(); cleanup(); }
});

test('备份/恢复不覆盖已有目标，缺失或损坏源不产生目标文件', async () => {
  const { names: [source, snapshot, restored, bad, fresh], cleanup } = files();
  const db = new Db(source); await db.close();
  try {
    await snapshotDatabase(source, snapshot);
    const original = readFileSync(snapshot);
    await assert.rejects(snapshotDatabase(source, snapshot), /TARGET_ALREADY_EXISTS/);
    await assert.rejects(snapshotDatabase(snapshot, source), /TARGET_ALREADY_EXISTS/);
    assert.deepEqual(readFileSync(snapshot), original);
    await assert.rejects(snapshotDatabase(fresh, restored), /SOURCE_DATABASE_NOT_FOUND/);
    writeFileSync(bad, 'this is not a SQLite database');
    await assert.rejects(snapshotDatabase(bad, restored));
    assert.equal(existsSync(restored), false);
  } finally { cleanup(); }
});

test('备份拒绝外键损坏或非DOOGY数据库，保留源文件', async () => {
  const { names: [source, snapshot, restored, bad], cleanup } = files();
  const db = new Db(source);
  try {
    await db.exec('PRAGMA foreign_keys=OFF');
    await db.run('INSERT INTO households VALUES (?,?,?,?)', 'orphan', 'bad', 'missing-user', db.now());
    await assert.rejects(snapshotDatabase(source, snapshot), /DATABASE_FOREIGN_KEYS_FAILED/);
    assert.equal(existsSync(snapshot), false);
    const unrelated = new DatabaseSync(bad); unrelated.exec('CREATE TABLE unrelated(id TEXT)'); unrelated.close();
    await assert.rejects(snapshotDatabase(bad, restored), /NOT_A_DOOGY_DATABASE/);
    assert.equal(existsSync(restored), false);
    assert.ok(existsSync(source));
  } finally { await db.close(); cleanup(); }
});
