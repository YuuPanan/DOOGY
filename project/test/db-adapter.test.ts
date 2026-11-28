import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Db, postgresSql } from '../src/db';

test('PostgreSQL参数适配保留字符串/引号，只转换实际参数及既有SQLite表达式', () => {
  assert.equal(postgresSql("SELECT '?' AS literal,'rowid' AS name,\"a?b\" FROM t WHERE ? IS NULL OR id=? ORDER BY rowid"),
    "SELECT '?' AS literal,'rowid' AS name,\"a?b\" FROM t WHERE $1::text IS NULL OR id=$2 ORDER BY __sequence");
  assert.equal(postgresSql("SELECT 'it''s ? MAX(COALESCE(' WHERE x=MAX(COALESCE(x,?),?)"),
    "SELECT 'it''s ? MAX(COALESCE(' WHERE x=GREATEST(COALESCE(x,$1),$2)");
});

test('异步SQLite事务隔离其他请求的读，回滚及嵌套保存点均完整', async () => {
  const db = new Db(':memory:');
  try {
    await db.exec('CREATE TABLE adapter_test(id TEXT PRIMARY KEY)');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { release = done; });
    const tx = db.transaction(async () => {
      await db.run('INSERT INTO adapter_test VALUES (?)', 'rollback');
      entered(); await gate; throw new Error('intentional rollback');
    });
    const rejected = assert.rejects(tx, /intentional rollback/);
    await started;
    let readFinished = false;
    const read = db.get('SELECT COUNT(*) AS n FROM adapter_test').then(row => { readFinished = true; return row; });
    await new Promise(done => setImmediate(done));
    assert.equal(readFinished, false);
    release(); await rejected;
    assert.equal((await read)!.n, 0);
    await db.transaction(async () => {
      await db.run('INSERT INTO adapter_test VALUES (?)', 'outer');
      await assert.rejects(db.transaction(async () => { await db.run('INSERT INTO adapter_test VALUES (?)', 'inner'); throw new Error('inner rollback'); }), /inner rollback/);
      assert.deepEqual((await db.all('SELECT id FROM adapter_test')).map(row => row.id), ['outer']);
    });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM adapter_test'))!.n, 1);
  } finally { await db.close(); }
});

test('PostgreSQL配置不完整时拒绝启动，不静默回退SQLite；SQLite快照工具拒绝误备份PG', async () => {
  await assert.rejects(Db.open({ driver: 'postgres', url: '' }), /DATABASE_URL/);
  await assert.rejects(Db.open({ driver: 'postgres', url: 'https://invalid.example' }), /valid PostgreSQL URL/);
  const run = spawnSync(process.execPath, [resolve('dist/scripts/backup-db.js')], {
    env: { ...process.env, DB_DRIVER: 'postgres' }, windowsHide: true, encoding: 'utf8'
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /SQLite only/);
});
