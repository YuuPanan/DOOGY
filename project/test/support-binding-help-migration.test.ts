import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Db } from '../src/db';

const migration = '022-support-binding-help.sql';

test('SQLite 021→022 保留工单与回复顺序，沿用撤权并允许绑定前文字工单', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'doogy-support-binding-migration-'));
  const path = join(directory, 'legacy.db');
  const old = new DatabaseSync(path);
  let db: Db | undefined;
  t.after(async () => {
    await db?.close();
    for (const suffix of ['', '-wal', '-shm']) try { unlinkSync(path + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    rmdirSync(directory);
  });

  const ticketRows = 'SELECT rowid,* FROM support_tickets ORDER BY rowid';
  const historyRows = 'SELECT rowid,* FROM support_ticket_history ORDER BY created_at,rowid';
  const schemaRows = `SELECT name,sql FROM sqlite_master WHERE name IN (
    'support_ticket_creator','support_ticket_status','support_history_ticket',
    'revoke_grants_after_member_removal','revoke_grants_after_device_unbind','revoke_shares_after_role_downgrade'
  ) ORDER BY name`;
  const expected = (() => {
    try {
      old.exec('PRAGMA foreign_keys=ON; CREATE TABLE migrations(name TEXT PRIMARY KEY)');
      for (const file of readdirSync(resolve('db')).filter(name => name.endsWith('.sql') && name < migration).sort()) {
        old.exec(readFileSync(resolve('db', file), 'utf8'));
        old.prepare('INSERT INTO migrations VALUES (?)').run(file);
      }
      old.exec(`INSERT INTO users(id,email,password_hash,created_at) VALUES
        ('owner','owner@example.invalid','unused','2026-11-18T00:00:00Z'),
        ('viewer','viewer@example.invalid','unused','2026-11-18T00:00:00Z');
        INSERT INTO households VALUES ('home','Migration home','owner','2026-11-18T00:00:00Z');
        INSERT INTO household_members VALUES
          ('home','owner','owner','2026-11-18T00:00:00Z'),('home','viewer','viewer','2026-11-18T00:00:00Z');
        INSERT INTO pets VALUES ('pet','home','Migration pet','dog',NULL,NULL,NULL,'2026-11-18T00:00:00Z','2026-11-18T00:00:00Z');
        INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at)
          VALUES ('device','MIGRATION','simulator','stub','unused','2026-11-18T00:00:00Z');
        INSERT INTO device_bindings VALUES ('binding','device','pet','owner','2026-11-18T00:00:00Z',NULL);
        INSERT INTO support_tickets(rowid,id,device_id,pet_id,binding_id,created_by,category,description,status,
          diagnostics_consented_at,diagnostics_expires_at,diagnostics_json,created_at,updated_at)
        VALUES
          (3,'owner-ticket','device','pet','binding','owner','battery','legacy owner','resolved',
            '2026-11-18T01:00:00Z','2026-11-25T01:00:00Z','{"battery_pct":62}','2026-11-18T01:00:00Z','2026-11-18T01:00:00Z'),
          (7,'viewer-ticket','device','pet','binding','viewer','location','legacy viewer','open',
            '2026-11-18T01:00:00Z','2026-11-25T01:00:00Z','{"battery_pct":62}','2026-11-18T01:00:00Z','2026-11-18T01:00:00Z');
        INSERT INTO support_ticket_history(rowid,id,ticket_id,actor_id,status,reply,created_at) VALUES
          (2,'zz-first','owner-ticket','owner','open','','2026-11-18T01:00:00Z'),
          (5,'bb-next','owner-ticket','owner','in_progress','working','2026-11-18T01:00:00Z'),
          (11,'aa-last','owner-ticket','owner','resolved','done','2026-11-18T01:00:00Z');`);
      return { tickets: old.prepare(ticketRows).all(), history: old.prepare(historyRows).all(), schema: old.prepare(schemaRows).all() };
    } finally { old.close(); }
  })();

  db = new Db(path);
  assert.ok(await db.get('SELECT name FROM migrations WHERE name=?', migration));
  assert.deepEqual(await db.all(ticketRows), expected.tickets);
  assert.deepEqual(await db.all(historyRows), expected.history);
  assert.deepEqual(await db.all(schemaRows), expected.schema);

  await db.run(`INSERT INTO support_tickets(id,created_by,category,description,created_at,updated_at)
    VALUES ('before-binding','owner','binding','no device yet','2026-11-18T01:00:00Z','2026-11-18T01:00:00Z')`);
  await assert.rejects(db.run(`UPDATE support_tickets SET device_id='device' WHERE id='before-binding'`), /CHECK constraint failed/);
  await assert.rejects(db.run(`UPDATE support_tickets SET category='battery' WHERE id='before-binding'`), /CHECK constraint failed/);
  await assert.rejects(db.run(`UPDATE support_tickets SET diagnostics_json='{}' WHERE id='before-binding'`), /CHECK constraint failed/);

  await db.run(`DELETE FROM household_members WHERE household_id='home' AND user_id='viewer'`);
  assert.equal((await db.get(`SELECT diagnostics_json FROM support_tickets WHERE id='viewer-ticket'`))!.diagnostics_json, null);
  assert.ok((await db.get(`SELECT diagnostics_revoked_at FROM support_tickets WHERE id='viewer-ticket'`))!.diagnostics_revoked_at);
  assert.ok((await db.get(`SELECT diagnostics_json FROM support_tickets WHERE id='owner-ticket'`))!.diagnostics_json);
  await db.run(`UPDATE device_bindings SET unbound_at='2026-11-18T02:00:00Z' WHERE id='binding'`);
  assert.equal((await db.get(`SELECT diagnostics_json FROM support_tickets WHERE id='owner-ticket'`))!.diagnostics_json, null);
  assert.ok((await db.get(`SELECT diagnostics_revoked_at FROM support_tickets WHERE id='owner-ticket'`))!.diagnostics_revoked_at);
  assert.equal((await db.get(`SELECT diagnostics_revoked_at FROM support_tickets WHERE id='before-binding'`))!.diagnostics_revoked_at, null);
  assert.deepEqual(await db.all(historyRows), expected.history);
  assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
  assert.equal((await db.get('PRAGMA integrity_check'))!.integrity_check, 'ok');
});
