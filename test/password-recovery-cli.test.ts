import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { PasswordRecoveryService } from '../src/password-recovery';

test('受控本地CLI只输出一次材料，数据库仅hash，重复/未知/API投递不返回材料', async () => {
  process.env.DATA_MODE = 'offline';
  const folder = mkdtempSync(resolve(tmpdir(), 'doogy-password-cli-')), filename = resolve(folder, 'isolated.db');
  const db = new Db(filename);
  try {
    const identity = new IdentityService(db), recovery = new PasswordRecoveryService(db);
    const owner = await identity.register({ email: 'recovery-cli@example.invalid', password: 'Synthetic-original-password' });
    const known = await recovery.request({ email: owner.user.email }), missing = await recovery.request({ email: 'missing@example.invalid' });
    const run = (id: string, mode = 'offline') => spawnSync(process.execPath, [resolve(__dirname, '../scripts/deliver-password-recovery.js'), id], {
      cwd: resolve('.'), env: { ...process.env, DATA_MODE: mode, DB_DRIVER: 'sqlite', DB_PATH: filename }, windowsHide: true, encoding: 'utf8', timeout: 15000,
    });
    const first = run(known.request_id); assert.equal(first.status, 0); assert.equal(first.stdout.trim().split(/\r?\n/).length, 1);
    const delivery = JSON.parse(first.stdout); assert.equal(delivery.delivery_status, 'offline_demo'); assert.equal(Buffer.from(delivery.token, 'base64url').length, 32);
    assert.equal(first.stderr.includes(delivery.token), false);
    const row = (await db.get('SELECT * FROM password_recovery_requests WHERE id=?', known.request_id))!;
    assert.equal(row.token_hash, createHash('sha256').update(delivery.token).digest('hex')); assert.equal(JSON.stringify(row).includes(delivery.token), false);
    const repeated = run(known.request_id), unknown = run(missing.request_id);
    assert.equal(repeated.status, 0); assert.equal(unknown.status, 0);
    assert.equal(Object.hasOwn(JSON.parse(repeated.stdout), 'token'), false); assert.equal(JSON.parse(unknown.stdout).delivery_status, 'skipped');
    process.env.DATA_MODE = 'api'; const api = await recovery.request({ email: owner.user.email });
    const unconfigured = run(api.request_id, 'api'); assert.equal(unconfigured.status, 0); assert.equal(JSON.parse(unconfigured.stdout).delivery_status, 'not_configured');
    assert.equal(Object.hasOwn(JSON.parse(unconfigured.stdout), 'token'), false);
    process.env.DATA_MODE = 'offline';
    assert.equal((await recovery.reset({ request_id: known.request_id, token: delivery.token, new_password: 'Synthetic-new-password' })).reset, true);
    const consumed = run(known.request_id); assert.equal(consumed.status, 0); assert.equal(Object.hasOwn(JSON.parse(consumed.stdout), 'token'), false);
    for (const table of ['password_recovery_requests', 'audit_logs', 'idempotency_keys']) assert.equal(JSON.stringify(await db.all(`SELECT * FROM ${table}`)).includes(delivery.token), false);
  } finally {
    process.env.DATA_MODE = 'offline'; await db.close();
    for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(filename + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    rmdirSync(folder);
  }
});
