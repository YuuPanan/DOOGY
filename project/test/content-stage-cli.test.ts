import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Db } from '../src/db';
import { ContentService } from '../src/content';

test('受控CLI从本地JSON原子导入目录，保留同版本不可变与发布乐观锁，未自动填充内容', async () => {
  const folder = mkdtempSync(resolve(tmpdir(), 'doogy-content-cli-'));
  const dbPath = resolve(folder, 'isolated.db'), filename = resolve(folder, 'catalog.json');
  const id = randomUUID();
  const payload = { items: [{ id, kind: 'guidance', content_version: 1, expected_revision: 0, status: 'draft', content: {
    title: 'Synthetic CLI draft', category: 'test-only', body: 'Synthetic draft, not approved advice.', applicability: 'Isolated CLI test', sources: [], review: { status: 'pending' },
  } }] };
  const env = { ...process.env, DB_DRIVER: 'sqlite', DB_PATH: dbPath, DATA_MODE: 'offline' };
  const run = () => spawnSync(process.execPath, [resolve('dist/scripts/import-content.js'), filename], { cwd: resolve('.'), env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  try {
    writeFileSync(filename, JSON.stringify(payload));
    const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).items[0].status, 'draft');
    const db = new Db(dbPath);
    try { assert.equal((await new ContentService(db).list('test-reader', {})).items.length, 0); assert.equal((await db.get('SELECT COUNT(*) AS n FROM content_items'))!.n, 1); }
    finally { await db.close(); }
    assert.notEqual(run().status, 0, 'stale catalog revision must fail');
    payload.items[0].expected_revision = 1;
    writeFileSync(filename, JSON.stringify(payload));
    assert.equal(run().status, 0, 'same immutable version with current revision is a no-op');
    payload.items[0].content.body = 'Changed same version'; writeFileSync(filename, JSON.stringify(payload));
    assert.notEqual(run().status, 0, 'same version cannot overwrite body');
  } finally {
    for (const file of [filename, dbPath, dbPath + '-wal', dbPath + '-shm']) { try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    rmdirSync(folder);
  }
});
