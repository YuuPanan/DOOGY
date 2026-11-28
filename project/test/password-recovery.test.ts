import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SQLInputValue } from 'node:sqlite';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { PasswordRecoveryService } from '../src/password-recovery';

const password = 'Synthetic-original-password', replacement = 'Synthetic-new-password', lifetime = 15 * 60000;
const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(database?: Db) {
  process.env.DATA_MODE = 'offline';
  let now = Date.parse('2026-11-24T09:00:00Z');
  const db = database ?? new Db(':memory:', () => new Date(now)), identity = new IdentityService(db), recovery = new PasswordRecoveryService(db);
  const owner = await identity.register({ email: 'recovery-owner@example.invalid', password });
  return { db, identity, recovery, owner, advance: (ms: number) => { now += ms; } };
}
async function assertNoRawSecret(db: Db, secret: string) {
  const tables = await db.all(db.driver === 'sqlite' ? "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    : "SELECT tablename AS name FROM pg_tables WHERE schemaname='public'");
  for (const table of tables) {
    assert.match(table.name, /^[a-z_][a-z_0-9]*$/);
    assert.equal(JSON.stringify(await db.all(`SELECT * FROM ${table.name}`)).includes(secret), false, `Raw secret must not be stored in ${table.name}`);
  }
}

test('已知/未知邮箱同结构受理、不改变会话，邮箱hash申请限额在失败后保留并在15分钟等号恢复', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const previous = (await f.db.get('SELECT password_hash FROM users WHERE id=?', f.owner.user.id))!.password_hash;
  const known = await f.recovery.request({ email: 'RECOVERY-OWNER@example.invalid' }), missing = await f.recovery.request({ email: 'missing@example.invalid' });
  assert.deepEqual(Object.keys(known).sort(), Object.keys(missing).sort());
  assert.equal(known.accepted, true); assert.equal(known.delivery_status, 'pending_local_delivery'); assert.equal(missing.delivery_status, known.delivery_status);
  assert.ok(known.request_id !== missing.request_id); assert.equal(Object.hasOwn(known, 'token'), false);
  assert.equal((await f.db.get('SELECT password_hash FROM users WHERE id=?', f.owner.user.id))!.password_hash, previous);
  assert.equal(await f.identity.userFromAccess(f.owner.access_token), f.owner.user.id);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', f.owner.user.id))!.n, 1);
  assert.equal((await f.db.get('SELECT token_hash FROM password_recovery_requests WHERE id=?', known.request_id))!.token_hash, null);
  for (let i = 1; i < 5; i++) {
    await f.recovery.request({ email: f.owner.user.email }); await f.recovery.request({ email: 'missing@example.invalid' });
  }
  for (const email of [f.owner.user.email, 'missing@example.invalid']) {
    await assert.rejects(f.recovery.request({ email }), status(429));
    const rate = await f.db.get('SELECT attempts FROM auth_attempts WHERE key=?', 'password-recovery:email:' + hash(email)); assert.equal(rate!.attempts, 5);
  }
  assert.equal(await f.identity.userFromAccess(f.owner.access_token), f.owner.user.id);
  f.advance(lifetime);
  assert.equal((await f.recovery.request({ email: f.owner.user.email })).accepted, true);
  assert.equal((await f.db.get('SELECT attempts FROM auth_attempts WHERE key=?', 'password-recovery:email:' + hash(f.owner.user.email)))!.attempts, 1);
});

test('本地只投递一次32bytes材料，reset原子消费、撤销所有会话和其他申请，清登录限制且不缓存秘密', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const secondSession = await f.identity.login({ email: f.owner.user.email, password });
  const first = await f.recovery.request({ email: f.owner.user.email }), second = await f.recovery.request({ email: f.owner.user.email });
  const delivered = await f.recovery.deliver(first.request_id), other = await f.recovery.deliver(second.request_id);
  assert.equal(delivered.delivery_status, 'offline_demo'); assert.equal(Buffer.from(delivered.token, 'base64url').length, 32);
  assert.equal(delivered.token.length, 43);
  const stored = await f.db.get('SELECT * FROM password_recovery_requests WHERE id=?', first.request_id);
  assert.equal(stored!.token_hash, hash(delivered.token)); assert.equal(stored!.delivered_at, f.db.now());
  assert.equal(Object.hasOwn(await f.recovery.deliver(first.request_id), 'token'), false);
  assert.equal((await f.db.get('SELECT token_hash FROM password_recovery_requests WHERE id=?', first.request_id))!.token_hash, stored!.token_hash);
  await assertNoRawSecret(f.db, delivered.token);
  for (let i = 0; i < 10; i++) await assert.rejects(f.identity.login({ email: f.owner.user.email, password: 'Incorrect-password' }), status(401));
  await assert.rejects(f.identity.login({ email: f.owner.user.email, password }), status(429));
  assert.deepEqual(await f.recovery.reset({ request_id: first.request_id, token: delivered.token, new_password: replacement }), { reset: true, sessions_revoked: true, relogin_required: true });
  const finished = (await f.db.get('SELECT * FROM password_recovery_requests WHERE id=?', first.request_id))!;
  assert.equal(finished.verified_at, f.db.now()); assert.equal(finished.consumed_at, f.db.now()); assert.equal(finished.token_hash, null);
  const invalidated = (await f.db.get('SELECT * FROM password_recovery_requests WHERE id=?', second.request_id))!;
  assert.equal(invalidated.invalidated_at, f.db.now()); assert.equal(invalidated.token_hash, null);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', f.owner.user.id))!.n, 0, 'reset must not automatically sign in');
  assert.equal(await f.db.get('SELECT key FROM auth_attempts WHERE key=?', f.owner.user.email), undefined);
  assert.equal((await f.db.get('SELECT attempts FROM auth_attempts WHERE key=?', 'password-recovery:email:' + hash(f.owner.user.email)))!.attempts, 2);
  for (const session of [f.owner, secondSession]) {
    await assert.rejects(f.identity.userFromAccess(session.access_token), status(401));
    await assert.rejects(f.identity.refresh({ refresh_token: session.refresh_token }), status(401));
  }
  await assert.rejects(f.recovery.reset({ request_id: first.request_id, token: delivered.token, new_password: 'Do-not-apply-this' }), status(400));
  await assert.rejects(f.recovery.reset({ request_id: second.request_id, token: other.token, new_password: 'Do-not-apply-this' }), status(400));
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM privacy_deletions WHERE kind='password_reset' AND resource_id=?", f.owner.user.id))!.n, 1);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n, 0);
  await assert.rejects(f.identity.login({ email: f.owner.user.email, password }), status(401));
  assert.ok((await f.identity.login({ email: f.owner.user.email, password: replacement })).access_token);
  await assertNoRawSecret(f.db, delivered.token); await assertNoRawSecret(f.db, replacement);
});

test('错误材料计数提交并在5次后只锁本申请，其他申请和账号仍可使用', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = await f.recovery.request({ email: f.owner.user.email }), second = await f.recovery.request({ email: f.owner.user.email });
  const one = await f.recovery.deliver(first.request_id), two = await f.recovery.deliver(second.request_id);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(f.recovery.reset({ request_id: first.request_id, token: `incorrect-${attempt}`, new_password: replacement }), status(400));
    assert.equal((await f.db.get('SELECT failed_attempts FROM password_recovery_requests WHERE id=?', first.request_id))!.failed_attempts, attempt);
  }
  const locked = (await f.db.get('SELECT * FROM password_recovery_requests WHERE id=?', first.request_id))!;
  assert.ok(locked.invalidated_at); assert.equal(locked.token_hash, null);
  await assert.rejects(f.recovery.reset({ request_id: first.request_id, token: one.token, new_password: replacement }), status(400));
  assert.equal((await f.db.get('SELECT failed_attempts FROM password_recovery_requests WHERE id=?', second.request_id))!.failed_attempts, 0);
  assert.equal(await f.identity.userFromAccess(f.owner.access_token), f.owner.user.id);
  assert.ok((await f.identity.login({ email: f.owner.user.email, password })).access_token);
  assert.equal((await f.recovery.reset({ request_id: second.request_id, token: two.token, new_password: replacement })).reset, true);
});

test('过期到等号即拒绝，维护清秘密和本purpose旧限额而保留请求元数据与登录额度', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const delivered = await f.recovery.request({ email: f.owner.user.email }), pending = await f.recovery.request({ email: 'missing@example.invalid' });
  const secret = await f.recovery.deliver(delivered.request_id);
  await f.db.run('INSERT INTO auth_attempts VALUES (?,?,?)', f.owner.user.email, f.db.now(), 1);
  const rows = (await f.db.get('SELECT COUNT(*) AS n FROM password_recovery_requests'))!.n;
  f.advance(lifetime);
  await assert.rejects(f.recovery.reset({ request_id: delivered.request_id, token: secret.token, new_password: replacement }), status(400));
  assert.equal(Object.hasOwn(await f.recovery.deliver(pending.request_id), 'token'), false);
  const another = await f.recovery.request({ email: f.owner.user.email });
  const active = await f.recovery.deliver(another.request_id); assert.equal(active.delivery_status, 'offline_demo');
  f.advance(lifetime);
  const result = await f.recovery.expire(); assert.ok(result.expired_requests >= 1); assert.ok(result.expired_rate_limits >= 1);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM password_recovery_requests'))!.n, rows + 1);
  assert.ok((await f.db.get('SELECT * FROM password_recovery_requests WHERE id=?', another.request_id))!.invalidated_at);
  assert.equal((await f.db.get('SELECT token_hash FROM password_recovery_requests WHERE id=?', another.request_id))!.token_hash, null);
  assert.ok(await f.db.get('SELECT key FROM auth_attempts WHERE key=?', f.owner.user.email));
});

test('未知与关闭账号投递skipped，API未配置不发材料，模式改变的旧材料不能恢复使用', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const missing = await f.recovery.request({ email: 'missing@example.invalid' });
  assert.equal((await f.recovery.deliver(missing.request_id)).delivery_status, 'skipped');
  const first = await f.recovery.request({ email: f.owner.user.email }), pending = await f.recovery.request({ email: f.owner.user.email });
  const delivered = await f.recovery.deliver(first.request_id);
  process.env.DATA_MODE = 'api';
  const knownApi = await f.recovery.request({ email: f.owner.user.email }), missingApi = await f.recovery.request({ email: 'missing@example.invalid' });
  assert.equal(knownApi.delivery_status, 'not_configured'); assert.equal(missingApi.delivery_status, 'not_configured');
  for (const request of [knownApi, missingApi, pending]) assert.equal(Object.hasOwn(await f.recovery.deliver(request.request_id), 'token'), false);
  await assert.rejects(f.recovery.reset({ request_id: first.request_id, token: delivered.token, new_password: replacement }), status(400));
  process.env.DATA_MODE = 'offline';
  await assert.rejects(f.recovery.reset({ request_id: first.request_id, token: delivered.token, new_password: replacement }), status(400));
  assert.equal(Object.hasOwn(await f.recovery.deliver(knownApi.request_id), 'token'), false);
  const closed = await f.recovery.request({ email: f.owner.user.email });
  await f.db.run('UPDATE users SET closed_at=? WHERE id=?', f.db.now(), f.owner.user.id);
  assert.equal((await f.recovery.deliver(closed.request_id)).delivery_status, 'skipped');
  await assert.rejects(f.recovery.reset({ request_id: closed.request_id, token: 'anything', new_password: replacement }), status(400));
});

test('同一材料并发reset只成功一次，事务失败不会留下第二份完成或恢复日志', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const request = await f.recovery.request({ email: f.owner.user.email }), delivery = await f.recovery.deliver(request.request_id);
  const results = await Promise.allSettled([replacement, 'Another-valid-password'].map(new_password => f.recovery.reset({ request_id: request.request_id, token: delivery.token, new_password })));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM privacy_deletions WHERE kind='password_reset'"))!.n, 1);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='account.password_reset'"))!.n, 1);
});

class PausingLoginDb extends Db {
  pause = false;
  onRead = () => {};
  resume = Promise.resolve();
  override async get<T = Row>(sql: string, ...params: SQLInputValue[]): Promise<T | undefined> {
    const row = await super.get<T>(sql, ...params);
    if (this.pause && /SELECT \* FROM users WHERE email=.*closed_at IS NULL/.test(sql)) {
      this.pause = false; this.onRead(); await this.resume;
    }
    return row;
  }
}
test('旧密码预检后reset先提交，后续登录不能再签发旧凭据会话', { timeout: 10000 }, async t => {
  const db = new PausingLoginDb(':memory:'), f = await fixture(db); t.after(() => db.close());
  const request = await f.recovery.request({ email: f.owner.user.email }), delivery = await f.recovery.deliver(request.request_id);
  let release!: () => void;
  const observed = new Promise<void>(done => { db.onRead = done; }); db.resume = new Promise<void>(done => { release = done; }); db.pause = true;
  const login = f.identity.login({ email: f.owner.user.email, password });
  try {
    await observed;
    await f.recovery.reset({ request_id: request.request_id, token: delivery.token, new_password: replacement });
  } finally { release(); }
  await assert.rejects(login, status(401));
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', f.owner.user.id))!.n, 0);
  assert.ok((await f.identity.login({ email: f.owner.user.email, password: replacement })).access_token);
});
