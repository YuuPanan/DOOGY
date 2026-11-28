import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Db } from '../src/db';
import { tables } from '../scripts/migrate-postgres';

const migrationName = '020-care-types.sql';
const migration = readFileSync(resolve('db', migrationName), 'utf8');

function legacyDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE migrations(name TEXT PRIMARY KEY)');
  for (const file of readdirSync(resolve('db')).filter(name => name.endsWith('.sql') && name < migrationName).sort()) {
    db.exec(readFileSync(resolve('db', file), 'utf8'));
    db.prepare('INSERT INTO migrations VALUES (?)').run(file);
  }
  db.exec(`INSERT INTO users(id,email,password_hash,created_at) VALUES
    ('owner','owner@example.invalid','unused','2026-11-17T00:00:00Z'),
    ('author','author@example.invalid','unused','2026-11-17T00:00:00Z');
    INSERT INTO households VALUES ('home','Migration home','owner','2026-11-17T00:00:00Z');
    INSERT INTO pets VALUES ('pet','home','Migration pet','dog',NULL,NULL,9,'2026-11-17T00:00:00Z','2026-11-17T00:00:00Z');
    INSERT INTO care_records VALUES
    ('active','pet','weight','{"weight_kg":9}','2026-11-17T01:00:00Z','owner','Active record','author','2026-11-17T01:00:00Z','2026-11-17T01:00:00Z',NULL,NULL,NULL),
    ('withdrawn','pet','note','{"text":"corrected"}','2026-11-17T02:00:00Z','vet','Withdrawn note','author','2026-11-17T02:00:00Z','2026-11-17T04:00:00Z','2026-11-17T04:00:00Z','owner','Duplicate note');
    INSERT INTO care_record_revisions VALUES
    ('edited','withdrawn','{"value":{"text":"original"},"created_by":"author"}','author','2026-11-17T03:00:00Z'),
    ('withdrawal','withdrawn','{"value":{"text":"corrected"},"withdrawn_at":null}','owner','2026-11-17T04:00:00Z');`);
  return db;
}
function schema(db: DatabaseSync) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
}

test('SQLite 019→最新：保留照护原文、作者、撤回与修订，恢复索引/外键并新增附件表', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'doogy-care-types-')), path = join(directory, 'legacy.db');
  let db: Db | undefined;
  t.after(async () => {
    await db?.close();
    for (const suffix of ['', '-wal', '-shm']) try { unlinkSync(path + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    rmdirSync(directory);
  });
  const legacy = legacyDatabase(path);
  legacy.exec(`INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES
    ('old-device','LEGACY-CLOSED','simulator','legacy','unused','2026-11-17T00:00:00Z');
    INSERT INTO safety_events(id,pet_id,device_id,type,occurred_at,details_json,status,closed_at) VALUES
    ('old-closure','pet','old-device','device.offline','2026-11-17T01:00:00Z','{}','closed','2026-11-17T02:00:00Z');`);
  const records = legacy.prepare('SELECT * FROM care_records ORDER BY id').all();
  const revisions = legacy.prepare('SELECT * FROM care_record_revisions ORDER BY id').all();
  const safety = legacy.prepare('SELECT * FROM safety_events').get()!;
  const safetyColumns = legacy.prepare('PRAGMA table_info(safety_events)').all();
  const rebuilt = ['care_records','care_record_revisions','care_pet_time','support_tickets','safety_events'];
  const otherSchema = schema(legacy).filter(row => !rebuilt.includes(String(row.name)));
  legacy.close();
  db = new Db(path);
  assert.deepEqual((await db.all('SELECT * FROM care_records ORDER BY id')).map(row => ({ ...row })), records.map(row => ({ ...row, custom_type: null })));
  assert.deepEqual(await db.all('SELECT * FROM care_record_revisions ORDER BY id'), revisions);
  assert.deepEqual({ ...await db.get('SELECT * FROM safety_events') }, { ...safety, closed_reason: null });
  assert.deepEqual((await db.all('PRAGMA table_info(safety_events)')).filter(row => row.name !== 'closed_reason'), safetyColumns);
  assert.deepEqual((await db.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))
    .filter(row => ![...rebuilt, 'care_attachments','care_attachment_record'].includes(String(row.name))
      && !['user_profiles','user_consents','user_onboarding','pet_avatars','pet_goals','body_check_ins','content_items','content_versions','learning_progress','health_observation_reads',
        'pet_media','behavior_records','interpretations','assistant_conversations','assistant_messages','pet_configuration_history','household_contacts','password_recovery_requests','contact_alerts','contact_alert_recipients'].includes(String(row.tbl_name))), otherSchema);
  assert.ok(await db.get('SELECT name FROM migrations WHERE name=?', migrationName));
  assert.match((await db.get("SELECT sql FROM sqlite_master WHERE name='care_pet_time'"))!.sql, /pet_id,recorded_at DESC,id DESC/);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'migrations'"))!.n, tables.length);
  assert.equal((await db.get('PRAGMA foreign_keys'))!.foreign_keys, 1);
  assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
  assert.equal((await db.get('PRAGMA integrity_check'))!.integrity_check, 'ok');
  for (const [type, name] of [['toileting', null], ['custom', '爪垫观察']]) {
    await db.run('INSERT INTO care_records(id,pet_id,type,value_json,recorded_at,source,notes,created_by,created_at,updated_at,custom_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      type, 'pet', type, '{}', '2026-11-17T05:00:00Z', 'owner', '', 'author', '2026-11-17T05:00:00Z', '2026-11-17T05:00:00Z', name);
  }
  await assert.rejects(db.run("UPDATE care_records SET custom_type='invalid' WHERE id='active'"), /CHECK constraint failed/);
  await assert.rejects(db.run("UPDATE care_records SET custom_type=NULL WHERE id='custom'"), /CHECK constraint failed/);
  await assert.rejects(db.run("UPDATE care_records SET type='unknown' WHERE id='active'"), /CHECK constraint failed/);
  await assert.rejects(db.run("INSERT INTO care_record_revisions VALUES ('orphan','missing','{}','author','now')"), /FOREIGN KEY constraint failed/);
  await assert.rejects(db.run("INSERT INTO care_record_revisions VALUES ('bad-author','active','{}','missing','now')"), /FOREIGN KEY constraint failed/);
  await assert.rejects(db.run("DELETE FROM care_records WHERE id='withdrawn'"), /FOREIGN KEY constraint failed/);
});

test('SQLite 照护重建中途失败可回滚父表、修订、撤回与全部schema', () => {
  const db = legacyDatabase();
  try {
    const before = { records: db.prepare('SELECT * FROM care_records ORDER BY id').all(), revisions: db.prepare('SELECT * FROM care_record_revisions ORDER BY id').all(), schema: schema(db) };
    db.exec('BEGIN IMMEDIATE');
    assert.throws(() => db.exec(migration.replace('ALTER TABLE care_records_new RENAME TO care_records;',
      'SELECT * FROM missing_care_types_test_table; ALTER TABLE care_records_new RENAME TO care_records;')), /no such table/);
    db.exec('ROLLBACK');
    assert.deepEqual(db.prepare('SELECT * FROM care_records ORDER BY id').all(), before.records);
    assert.deepEqual(db.prepare('SELECT * FROM care_record_revisions ORDER BY id').all(), before.revisions);
    assert.deepEqual(schema(db), before.schema);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all(), []);
    assert.equal(db.prepare('SELECT name FROM migrations WHERE name=?').get(migrationName), undefined);
  } finally { db.close(); }
});
