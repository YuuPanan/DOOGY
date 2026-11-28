import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { exportAccount } from '../scripts/export-account';
import { AccountExportService } from '../src/account-export';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { DevicesService, provisionDevice } from '../src/devices';
import { NotificationService } from '../src/notifications';

const password = 'Synthetic-export-cli-2026';
const files = () => {
  const target = resolve('data', `account-export-cli-test-${randomUUID()}.ndjson`);
  return { target, cleanup: () => { if (existsSync(target)) unlinkSync(target); } };
};

async function fixture(path = ':memory:') {
  process.env.DATA_MODE = 'offline';
  const db = new Db(path), identity = new IdentityService(db);
  const owner = await identity.register({ email: 'export-cli-owner@example.invalid', password });
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Export CLI private pet' });
  const device = await provisionDevice(db, { serial_no: `EXPORT-CLI-${randomUUID()}` });
  await new DevicesService(db).claim(owner.user.id, { ...device, pet_id: pet.id });
  await new NotificationService(db).registerToken(owner.user.id, { platform: 'ios', token: 'private-export-cli-push-token' });
  return { db, identity, owner, pet, device };
}

test('本地导出逐页写NDJSON，记录数与前缀/整文件散列可复验且不包含认证秘密', async t => {
  const { target, cleanup } = files(), f = await fixture();
  t.after(async () => { await f.db.close(); cleanup(); });
  await f.db.transaction(async () => {
    for (let n = 0; n < 201; n++) await f.db.run('INSERT INTO pets(id,household_id,name,species,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      randomUUID(), f.owner.household.id, `Export row ${n}`, 'dog', f.db.now(), f.db.now());
  });
  const sourceHash = (await f.db.get('SELECT password_hash FROM users WHERE id=?', f.owner.user.id))!.password_hash;
  const result = await exportAccount(f.db, f.owner.access_token, target), text = readFileSync(target, 'utf8');
  const lines = text.trimEnd().split('\n'), records = lines.map(line => JSON.parse(line));
  assert.equal(records[0].type, 'manifest'); assert.equal(records[0].format, 'doogy-account-export-v1');
  assert.equal(records[0].user.id, f.owner.user.id);
  const complete = records.at(-1)!; assert.equal(complete.type, 'complete');
  const data = records.filter(row => row.type === 'record');
  assert.equal(complete.rows, data.length); assert.equal(result.rows, data.length);
  assert.equal(complete.counts.reduce((sum: number, row: Row) => sum + row.records, 0), data.length);
  assert.equal(data.filter(row => row.section === 'pets').length, 202);
  const prefix = lines.slice(0, -1).join('\n') + '\n';
  assert.equal(complete.content_sha256, createHash('sha256').update(prefix).digest('hex'));
  assert.equal(result.sha256, createHash('sha256').update(text).digest('hex'));
  for (const secret of [password, sourceHash, f.owner.access_token, f.owner.refresh_token, f.device.device_token,
    f.device.claim_code, 'private-export-cli-push-token', 'password_hash', 'access_hash', 'refresh_hash', 'secret_hash', 'claim_hash']) {
    assert.ok(!text.includes(secret), 'Authentication material found in export');
  }
});

test('导出不覆盖已有文件，分页间登录被撤销时删除本次未完成文件', async t => {
  const f = await fixture(), { target, cleanup } = files();
  t.after(async () => { await f.db.close(); cleanup(); });
  writeFileSync(target, 'original');
  await assert.rejects(exportAccount(f.db, f.owner.access_token, target));
  assert.equal(readFileSync(target, 'utf8'), 'original'); unlinkSync(target);
  const original = AccountExportService.prototype.page;
  let revoke = true;
  AccountExportService.prototype.page = async function(user: string, section: string, query: unknown): Promise<Row> {
    const page = await original.call(this, user, section, query);
    if (revoke) { revoke = false; await f.identity.logout(`Bearer ${f.owner.access_token}`); }
    return page;
  };
  try { await assert.rejects(exportAccount(f.db, f.owner.access_token, target)); }
  finally { AccountExportService.prototype.page = original; }
  assert.equal(existsSync(target), false);
});

test('CLI从环境读取访问令牌，只输出文件与校验摘要，缺令牌不生成文件', async t => {
  const source = resolve('data', `account-export-cli-source-${randomUUID()}.db`), { target, cleanup } = files();
  const f = await fixture(source); await f.db.close();
  t.after(() => { cleanup(); for (const suffix of ['', '-wal', '-shm']) if (existsSync(source + suffix)) unlinkSync(source + suffix); });
  const env: NodeJS.ProcessEnv = { ...process.env, DB_DRIVER: 'sqlite', DB_PATH: source, DATA_MODE: 'offline' };
  delete env.DOOGY_ACCESS_TOKEN;
  const missing = spawnSync(process.execPath, [resolve('dist/scripts/export-account.js'), target], { env, windowsHide: true, encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.equal(existsSync(target), false);
  const run = spawnSync(process.execPath, [resolve('dist/scripts/export-account.js'), target], {
    env: { ...env, DOOGY_ACCESS_TOKEN: f.owner.access_token }, windowsHide: true, encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout); assert.equal(report.path, target); assert.ok(report.rows > 0);
  assert.equal(report.sha256, createHash('sha256').update(readFileSync(target)).digest('hex'));
  for (const secret of [f.owner.access_token, f.owner.refresh_token, f.owner.user.email, password, f.device.device_token, 'Export CLI private pet']) {
    assert.ok(!(run.stdout + run.stderr).includes(secret));
  }
});
