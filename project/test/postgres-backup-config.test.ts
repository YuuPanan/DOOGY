import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { backupPostgres, restorePostgres } from '../scripts/postgres-backup';

test('备份恢复拒绝URL路由覆盖和会截断/越界的目标名，不创建文件或连接其他实例', async () => {
  const target = resolve('data/invalid-backup-config.dump');
  assert.equal(existsSync(target), false);
  for (const query of ['host=another.example', 'port=5432', 'dbname=postgres', 'service=other']) {
    await assert.rejects(backupPostgres(`postgresql://doogy@127.0.0.1:55432/doogy?${query}`, target), /POSTGRES_URL_ROUTING_OVERRIDE/);
  }
  for (const name of ['postgres', 'template0', 'template1', 'a'.repeat(64), 'has-dash', 'name;drop']) {
    await assert.rejects(restorePostgres('postgresql://doogy@127.0.0.1:55432/doogy', 'missing.dump', name), /NEW_DATABASE_NAME_REQUIRED/);
  }
  assert.equal(existsSync(target), false);
});
