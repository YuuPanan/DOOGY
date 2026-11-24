import { Body, Controller, Header, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Db, Row } from './db';
import { settings } from './config';
import { fail, JsonBody, Public } from './http';
import { passwordHash } from './identity';

const requestBody = z.object({ email: z.email().max(254).transform(value => value.toLowerCase()) }).strict();
const resetBody = z.object({ request_id: z.uuid(), token: z.string().min(1).max(200), new_password: z.string().min(8).max(128) }).strict();
const lifetime = 15 * 60_000, maxAttempts = 5;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ratePrefix = 'password-recovery:email:';

export async function invalidatePasswordRecoveryRequests(db: Db, userId: string) {
  const now = db.now();
  return db.run(`UPDATE password_recovery_requests SET token_hash=NULL,invalidated_at=COALESCE(invalidated_at,?),
    delivery_status=CASE WHEN delivery_status='pending_local_delivery' THEN 'skipped' ELSE delivery_status END,updated_at=?
    WHERE user_id=? AND consumed_at IS NULL AND (invalidated_at IS NULL OR token_hash IS NOT NULL OR delivery_status='pending_local_delivery')`, now, now, userId);
}

export class PasswordRecoveryService {
  constructor(@Inject(Db) readonly db: Db) {}

  async request(raw: unknown): Promise<Row> {
    const input = requestBody.parse(raw), emailHash = hash(input.email), key = ratePrefix + emailHash;
    const allowed = await this.db.transaction(async () => {
      const previous = await this.db.get('SELECT window_started,attempts FROM auth_attempts WHERE key=?', key);
      const active = previous && Date.parse(previous.window_started) + lifetime > this.db.clock().getTime();
      if (active && previous.attempts >= maxAttempts) return false;
      await this.db.run(`INSERT INTO auth_attempts(key,window_started,attempts) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET window_started=excluded.window_started,attempts=excluded.attempts`, key,
        active ? previous.window_started : this.db.now(), active ? previous.attempts + 1 : 1);
      return true;
    });
    if (!allowed) fail(429, 'PASSWORD_RECOVERY_RATE_LIMITED', '申请次数过多，请稍后再试');
    return this.db.transaction(async () => {
      const user = await this.db.get('SELECT id FROM users WHERE email=? AND closed_at IS NULL', input.email);
      const id = this.db.id(), now = this.db.now(), mode = settings().DATA_MODE;
      const delivery = mode === 'offline' ? 'pending_local_delivery' : 'not_configured';
      await this.db.run(`INSERT INTO password_recovery_requests(id,user_id,email_hash,captured_mode,delivery_status,created_at,expires_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`, id, user?.id ?? null, emailHash, mode, delivery, now, new Date(this.db.clock().getTime() + lifetime).toISOString(), now);
      await this.db.audit(null, 'password_recovery.requested', id, { delivery_status: delivery, captured_mode: mode });
      return { accepted: true, request_id: id, delivery_status: delivery };
    });
  }
  private async invalidate(id: string) {
    await this.db.run(`UPDATE password_recovery_requests SET token_hash=NULL,invalidated_at=COALESCE(invalidated_at,?),
      delivery_status=CASE WHEN delivery_status='pending_local_delivery' THEN 'skipped' ELSE delivery_status END,updated_at=? WHERE id=?`, this.db.now(), this.db.now(), id);
  }
  async deliver(requestId: string): Promise<Row> {
    z.uuid().parse(requestId);
    return this.db.transaction(async () => {
      const row = await this.db.get('SELECT * FROM password_recovery_requests WHERE id=?', requestId);
      if (!row) fail(404, 'PASSWORD_RECOVERY_NOT_FOUND', '找回申请不存在');
      const mode = settings().DATA_MODE;
      if (mode === 'api' || row.captured_mode !== 'offline') {
        await this.invalidate(row.id);
        await this.db.run("UPDATE password_recovery_requests SET delivery_status='not_configured' WHERE id=?", row.id);
        return { request_id: row.id, delivery_status: 'not_configured' };
      }
      if (row.invalidated_at || row.consumed_at || row.expires_at <= this.db.now() || row.failed_attempts >= maxAttempts) {
        if (!row.consumed_at) await this.invalidate(row.id);
        return { request_id: row.id, delivery_status: 'skipped' };
      }
      const user = row.user_id ? await this.db.get('SELECT email FROM users WHERE id=? AND closed_at IS NULL', row.user_id) : null;
      if (!user || hash(user.email) !== row.email_hash) {
        await this.invalidate(row.id);
        await this.db.run("UPDATE password_recovery_requests SET delivery_status='skipped' WHERE id=?", row.id);
        return { request_id: row.id, delivery_status: 'skipped' };
      }
      if (row.delivery_status !== 'pending_local_delivery' || row.token_hash) return { request_id: row.id, delivery_status: 'skipped' };
      const token = randomBytes(32).toString('base64url'), now = this.db.now();
      await this.db.run("UPDATE password_recovery_requests SET token_hash=?,delivery_status='offline_demo',delivered_at=?,updated_at=? WHERE id=?", hash(token), now, now, row.id);
      await this.db.audit(null, 'password_recovery.local_delivered', row.id);
      return { request_id: row.id, delivery_status: 'offline_demo', expires_at: row.expires_at, token };
    });
  }
  async reset(raw: unknown): Promise<Row> {
    const input = resetBody.parse(raw);
    const accepted = await this.db.transaction(async () => {
      const row = await this.db.get(`SELECT r.*,u.email,u.closed_at FROM password_recovery_requests r LEFT JOIN users u ON u.id=r.user_id WHERE r.id=?`, input.request_id);
      if (!row) return false;
      if (row.consumed_at || row.invalidated_at) return false;
      if (row.captured_mode !== settings().DATA_MODE || row.expires_at <= this.db.now() || row.failed_attempts >= maxAttempts || !row.user_id || row.closed_at || !row.email || hash(row.email) !== row.email_hash) {
        await this.invalidate(row.id); return false;
      }
      const supplied = Buffer.from(hash(input.token), 'hex'), expected = Buffer.from(row.token_hash ?? '0'.repeat(64), 'hex');
      if (!row.token_hash || row.delivery_status !== 'offline_demo' || !timingSafeEqual(supplied, expected)) {
        const attempts = Math.min(maxAttempts, row.failed_attempts + 1);
        await this.db.run('UPDATE password_recovery_requests SET failed_attempts=?,updated_at=? WHERE id=?', attempts, this.db.now(), row.id);
        if (attempts >= maxAttempts) await this.invalidate(row.id);
        return false;
      }
      const now = this.db.now();
      await this.db.run('UPDATE users SET password_hash=? WHERE id=? AND closed_at IS NULL', passwordHash(input.new_password), row.user_id);
      await this.db.run('UPDATE password_recovery_requests SET token_hash=NULL,verified_at=?,consumed_at=?,updated_at=? WHERE id=?', now, now, now, row.id);
      await this.db.run('DELETE FROM sessions WHERE user_id=?', row.user_id);
      await invalidatePasswordRecoveryRequests(this.db, row.user_id);
      await this.db.run('DELETE FROM auth_attempts WHERE key=?', row.email);
      await this.db.audit(row.user_id, 'account.password_reset', row.user_id, { request_id: row.id });
      await this.db.recordDeletion('password_reset', row.user_id);
      return true;
    });
    if (!accepted) fail(400, 'INVALID_PASSWORD_RESET', '验证材料无效或已过期');
    return { reset: true, sessions_revoked: true, relogin_required: true };
  }
  async expire(): Promise<Row> {
    return this.db.transaction(async () => {
      const now = this.db.now();
      const requests = await this.db.run(`UPDATE password_recovery_requests SET token_hash=NULL,invalidated_at=COALESCE(invalidated_at,?),
        delivery_status=CASE WHEN delivery_status='pending_local_delivery' THEN 'skipped' ELSE delivery_status END,updated_at=?
        WHERE expires_at<=? AND consumed_at IS NULL AND (invalidated_at IS NULL OR token_hash IS NOT NULL OR delivery_status='pending_local_delivery')`, now, now, now);
      const limits = await this.db.run('DELETE FROM auth_attempts WHERE key LIKE ? AND window_started<=?', ratePrefix + '%', new Date(this.db.clock().getTime() - lifetime).toISOString());
      return { expired_requests: requests.changes, expired_rate_limits: limits.changes };
    });
  }
}

@ApiTags('密码找回') @Controller('auth')
export class PasswordRecoveryController {
  constructor(@Inject(PasswordRecoveryService) readonly recovery: PasswordRecoveryService) {}
  @Public() @Post('password-recovery') @HttpCode(202) @JsonBody(requestBody) @Header('Cache-Control', 'no-store')
  request(@Body() body: unknown) { return this.recovery.request(body); }
  @Public() @Post('password-reset') @HttpCode(200) @JsonBody(resetBody) @Header('Cache-Control', 'no-store')
  reset(@Body() body: unknown) { return this.recovery.reset(body); }
}
