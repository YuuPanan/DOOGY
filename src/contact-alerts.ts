import { Body, Controller, Get, Header, Headers, HttpCode, HttpException, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { settings } from './config';
import { CurrentUser, dateTime, fail, JsonBody, pageQuery } from './http';
import { purgeSourceCopies } from './source-invalidation';

const recipientBody = z.object({ contact_id: z.uuid(), expected_version: z.number().int().positive(), method: z.enum(['email', 'phone']) }).strict();
const createBody = z.object({ message: z.string().trim().min(1).max(1000), consent: z.literal(true),
  recipients: z.array(recipientBody).min(1).max(10).refine(rows => new Set(rows.map(row => row.contact_id)).size === rows.length, '同一联系人只能选择一次'),
  expires_in_seconds: z.number().int().min(60).max(3600).default(900) }).strict();
const attemptBody = z.object({ expected_attempt: z.number().int().positive() }).strict();
const listQuery = pageQuery.extend({ cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
const cursorSchema = z.object({ user: z.uuid(), pet: z.uuid(), created_at: dateTime, id: z.uuid() }).strict();
function summary(alert: Row, recipients: Row[]): Row {
  const counts = { total: recipients.length, pending: 0, simulated: 0, failed: 0, cancelled: 0 };
  for (const row of recipients) counts[row.status as 'pending' | 'simulated' | 'failed' | 'cancelled']++;
  const status = counts.pending ? 'pending' : counts.simulated === counts.total ? 'simulated' : counts.simulated ? 'partial' : counts.failed ? 'failed' : 'cancelled';
  return { ...alert, status, counts, content_scope: 'message_only', location_link_included: false, recipient_consent_verified: false };
}

export async function invalidateContactAlerts(db: Db, contactId: string, reason: string, deleted = false) {
  return db.transaction(async () => {
    const recipients = await db.all('SELECT id,alert_id,status FROM contact_alert_recipients WHERE contact_id=?', contactId);
    const changed = recipients.filter(row => !['simulated', 'cancelled'].includes(row.status)), now = db.now();
    for (const row of changed) await db.run("UPDATE contact_alert_recipients SET status='failed',error_code=?,execution_source=NULL,processed_at=? WHERE id=?", deleted ? 'CONTACT_DELETED' : reason, now, row.id);
    for (const alert of new Set(changed.map(row => row.alert_id))) await db.run('UPDATE contact_alerts SET updated_at=? WHERE id=?', now, alert);
    if (deleted) await db.run('UPDATE contact_alert_recipients SET contact_id=NULL WHERE contact_id=?', contactId);
    const ids = new Set<string>(recipients.flatMap(row => [row.id, row.alert_id]));
    const copies = await purgeSourceCopies(db, ids);
    return { affected_rows: changed.length, ...copies };
  });
}

export class ContactAlertsService {
  constructor(@Inject(Db) readonly db: Db) {}
  private async contact(household: string, id: string): Promise<Row | undefined> {
    return this.db.get(`SELECT id,version,consent_status,
      CASE WHEN email IS NOT NULL AND email<>'' THEN 1 ELSE 0 END AS has_email,
      CASE WHEN phone IS NOT NULL AND phone<>'' THEN 1 ELSE 0 END AS has_phone FROM household_contacts WHERE id=? AND household_id=?`, id, household);
  }
  private async selectedContact(household: string, id: string, version: number, method: string, retry = false) {
    const contact = await this.contact(household, id);
    if (!contact) fail(retry ? 409 : 404, 'CONTACT_DELETED', '联系人不存在、已删除或不属于本家庭');
    if (contact.version !== version) fail(409, 'CONTACT_CHANGED', '联系人已修改，请重新选择并创建请求');
    if (!contact[`has_${method}`]) fail(409, 'CONTACT_METHOD_UNAVAILABLE', '所选联系方式不可用');
    return contact;
  }
  private async alert(user: string, id: string, write = false): Promise<Row> {
    const alert = await this.db.get('SELECT * FROM contact_alerts WHERE id=?', id);
    if (!alert) fail(404, 'CONTACT_ALERT_NOT_FOUND', '联系人通知请求不存在');
    const pet = await this.db.pet(user, alert.pet_id, write);
    return { ...alert, household_id: pet.household_id };
  }
  private async expirePending(alert: Row) {
    if (alert.expires_at > this.db.now()) return 0;
    const result = await this.db.run("UPDATE contact_alert_recipients SET status='failed',error_code='REQUEST_EXPIRED',execution_source=NULL,processed_at=? WHERE alert_id=? AND status='pending'", this.db.now(), alert.id);
    if (result.changes) await this.db.run('UPDATE contact_alerts SET updated_at=? WHERE id=?', this.db.now(), alert.id);
    return result.changes;
  }
  async create(user: string, pet: string, raw: unknown, key?: string): Promise<Row> {
    const parsed = createBody.parse(raw), input = { ...parsed, recipients: [...parsed.recipients].sort((a, b) => a.contact_id.localeCompare(b.contact_id)) };
    return this.db.transaction(async () => {
      const current = await this.db.pet(user, pet, true);
      for (const recipient of input.recipients) await this.selectedContact(current.household_id, recipient.contact_id, recipient.expected_version, recipient.method);
      const { id } = await this.db.idempotent(user, `POST /pets/${pet}/contact-alerts`, key, input, async () => {
        const id = this.db.id(), now = this.db.now(), mode = settings().DATA_MODE;
        await this.db.run('INSERT INTO contact_alerts(id,pet_id,message,captured_mode,attempt,created_by,requested_by,created_at,expires_at,updated_at) VALUES (?,?,?,?,1,?,?,?,?,?)',
          id, pet, input.message, mode, user, user, now, new Date(this.db.clock().getTime() + input.expires_in_seconds * 1000).toISOString(), now);
        for (const recipient of input.recipients) await this.db.run(`INSERT INTO contact_alert_recipients(id,alert_id,contact_id,contact_version,method,attempt,status,error_code,execution_source,queued_at,processed_at)
          VALUES (?,?,?,?,?,1,'pending',NULL,NULL,?,NULL)`, this.db.id(), id, recipient.contact_id, recipient.expected_version, recipient.method, now);
        await this.db.audit(user, 'contact_alert.requested', id, { pet_id: pet, recipient_count: input.recipients.length, content_scope: 'message_only' });
        return { id };
      });
      return this.get(user, id);
    });
  }
  async list(user: string, pet: string, raw: unknown): Promise<Row> {
    const input = listQuery.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet);
      let after: z.infer<typeof cursorSchema> | null = null;
      if (input.cursor !== undefined) {
        try {
          const bytes = Buffer.from(input.cursor, 'base64url');
          if (bytes.toString('base64url') !== input.cursor) throw new Error('Noncanonical cursor');
          after = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
        } catch { fail(400, 'INVALID_CURSOR', '联系人通知历史游标无效'); }
        if (after.user !== user || after.pet !== pet) fail(400, 'INVALID_CURSOR', '联系人通知历史游标不属于当前用户或宠物');
      }
      const rows = await this.db.all(`SELECT * FROM contact_alerts WHERE pet_id=?
        ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
        pet, ...(after ? [after.created_at, after.created_at, after.id] : []), input.limit + 1);
      const items = rows.slice(0, input.limit), grouped = new Map<string, Row[]>();
      if (items.length) {
        const recipients = await this.db.all(`SELECT alert_id,status FROM contact_alert_recipients WHERE alert_id IN (${items.map(() => '?').join(',')})`, ...items.map(row => row.id));
        for (const recipient of recipients) { const group = grouped.get(recipient.alert_id) ?? []; group.push(recipient); grouped.set(recipient.alert_id, group); }
        const now = this.db.now(), expired = items.filter(row => row.expires_at <= now && grouped.get(row.id)?.some(recipient => recipient.status === 'pending'));
        if (expired.length) {
          const placeholders = expired.map(() => '?').join(','), ids = expired.map(row => row.id);
          await this.db.run(`UPDATE contact_alert_recipients SET status='failed',error_code='REQUEST_EXPIRED',execution_source=NULL,processed_at=? WHERE status='pending' AND alert_id IN (${placeholders})`, now, ...ids);
          await this.db.run(`UPDATE contact_alerts SET updated_at=? WHERE id IN (${placeholders})`, now, ...ids);
          for (const row of expired) { row.updated_at = now; for (const recipient of grouped.get(row.id)!) if (recipient.status === 'pending') recipient.status = 'failed'; }
        }
      }
      const last = items.at(-1);
      return { pet_id: pet, items: items.map(row => summary(row, grouped.get(row.id) ?? [])),
        next_cursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ user, pet, created_at: last!.created_at, id: last!.id })).toString('base64url') : null };
    });
  }
  async get(user: string, id: string): Promise<Row> {
    return this.db.transaction(async () => {
      const alert = await this.alert(user, id); await this.expirePending(alert);
      const saved = (await this.db.get('SELECT * FROM contact_alerts WHERE id=?', id))!;
      const recipients = await this.db.all('SELECT * FROM contact_alert_recipients WHERE alert_id=? ORDER BY queued_at,id', id);
      return { ...summary(saved, recipients),
        recipients: recipients.map(row => ({ ...row, consent_verified: false, consent_source: 'household_member_reported' })) };
    });
  }
  async retry(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    const input = attemptBody.parse(raw);
    await this.get(user, id);
    return this.db.transaction(async () => {
      const alert = await this.alert(user, id, true);
      if (alert.expires_at <= this.db.now()) fail(409, 'REQUEST_EXPIRED', '请求已过期，请重新显式选择收件人');
      const failed = await this.db.all("SELECT * FROM contact_alert_recipients WHERE alert_id=? AND status='failed'", id);
      for (const row of failed) {
        if (['CONTACT_CHANGED', 'CONTACT_DELETED', 'REQUEST_EXPIRED'].includes(row.error_code) || !row.contact_id) fail(409, 'CONTACT_ALERT_SOURCE_INVALIDATED', '原始收件人已失效，请重新选择并创建请求');
        const contact = await this.selectedContact(alert.household_id, row.contact_id, row.contact_version, row.method, true);
        if (contact.consent_status !== 'reported_granted') fail(409, 'RECIPIENT_CONSENT_REQUIRED', '尚未有成员报告收件同意，请先确认联系人资料');
      }
      const receipt = await this.db.idempotent(user, `POST /contact-alerts/${id}/retry`, key, input, async () => {
        if (alert.attempt !== input.expected_attempt) fail(409, 'ATTEMPT_CONFLICT', '请求尝试已改变，请重读后再试');
        if (!failed.length || await this.db.get("SELECT id FROM contact_alert_recipients WHERE alert_id=? AND status='pending' LIMIT 1", id)) fail(409, 'CONTACT_ALERT_NOT_RETRYABLE', '仅已结束且存在可重试失败收件人的请求可以重排');
        const now = this.db.now(), attempt = alert.attempt + 1;
        await this.db.run('UPDATE contact_alerts SET attempt=?,captured_mode=?,requested_by=?,updated_at=? WHERE id=?', attempt, settings().DATA_MODE, user, now, id);
        await this.db.run("UPDATE contact_alert_recipients SET status='pending',attempt=?,error_code=NULL,execution_source=NULL,queued_at=?,processed_at=NULL WHERE alert_id=? AND status='failed'", attempt, now, id);
        await this.db.audit(user, 'contact_alert.retried', id, { pet_id: alert.pet_id, previous_attempt: alert.attempt, retried_count: failed.length });
        return { id };
      });
      return this.get(user, receipt.id);
    });
  }
  async cancel(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    const input = attemptBody.parse(raw);
    await this.get(user, id);
    return this.db.transaction(async () => {
      const alert = await this.alert(user, id, true);
      const receipt = await this.db.idempotent(user, `POST /contact-alerts/${id}/cancel`, key, input, async () => {
        if (alert.attempt !== input.expected_attempt) fail(409, 'ATTEMPT_CONFLICT', '请求尝试已改变，请重读后再试');
        const now = this.db.now(), changed = await this.db.run("UPDATE contact_alert_recipients SET status='cancelled',error_code=NULL,execution_source=NULL,processed_at=? WHERE alert_id=? AND status='pending'", now, id);
        if (changed.changes) {
          await this.db.run('UPDATE contact_alerts SET updated_at=? WHERE id=?', now, id);
          await this.db.audit(user, 'contact_alert.cancelled', id, { pet_id: alert.pet_id, attempt: alert.attempt, cancelled_count: changed.changes });
        } else if (!await this.db.get("SELECT id FROM contact_alert_recipients WHERE alert_id=? AND status='cancelled' LIMIT 1", id)) fail(409, 'CONTACT_ALERT_NOT_CANCELLABLE', '没有尚待处理的收件人');
        return { id };
      });
      return this.get(user, receipt.id);
    });
  }
  async expire(): Promise<Row> {
    return this.db.transaction(async () => {
      const rows = await this.db.all("SELECT * FROM contact_alerts a WHERE expires_at<=? AND EXISTS(SELECT 1 FROM contact_alert_recipients r WHERE r.alert_id=a.id AND r.status='pending')", this.db.now());
      let recipients = 0;
      for (const row of rows) recipients += await this.expirePending(row);
      return { expired_alerts: rows.length, expired_recipients: recipients };
    });
  }
  async work(limit = 100) {
    z.number().int().positive().max(1000).parse(limit); let handled = 0;
    for (let index = 0; index < limit; index++) {
      const found = await this.db.transaction(async () => {
        const alert = await this.db.get("SELECT * FROM contact_alerts a WHERE EXISTS(SELECT 1 FROM contact_alert_recipients r WHERE r.alert_id=a.id AND r.status='pending') ORDER BY created_at,id LIMIT 1");
        if (!alert) return false;
        if (await this.expirePending(alert)) return true;
        let failure: string | null = null, household: string | null = null;
        const actor = alert.requested_by ? await this.db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', alert.requested_by) : null;
        if (!actor) failure = 'ACCESS_REVOKED';
        else {
          try { household = (await this.db.pet(actor.id, alert.pet_id, true)).household_id; }
          catch (error) {
            if (error instanceof HttpException && [403, 404].includes(error.getStatus())) failure = 'ACCESS_REVOKED';
            else throw error;
          }
        }
        if (!failure && alert.captured_mode !== settings().DATA_MODE) failure = 'DATA_MODE_CHANGED';
        const pending = await this.db.all("SELECT * FROM contact_alert_recipients WHERE alert_id=? AND status='pending' ORDER BY id", alert.id), now = this.db.now();
        for (const row of pending) {
          let error = failure;
          if (!error) {
            const contact = row.contact_id ? await this.contact(household!, row.contact_id) : undefined;
            error = !contact ? 'CONTACT_DELETED' : contact.version !== row.contact_version ? 'CONTACT_CHANGED'
              : !contact[`has_${row.method}`] ? 'CONTACT_METHOD_UNAVAILABLE' : contact.consent_status !== 'reported_granted' ? 'RECIPIENT_CONSENT_REQUIRED'
              : alert.captured_mode === 'api' ? 'CHANNEL_NOT_CONFIGURED' : null;
          }
          await this.db.run('UPDATE contact_alert_recipients SET status=?,error_code=?,execution_source=?,processed_at=? WHERE id=? AND status=?',
            error ? 'failed' : 'simulated', error, error ? null : 'offline_demo', now, row.id, 'pending');
        }
        await this.db.run('UPDATE contact_alerts SET updated_at=? WHERE id=?', now, alert.id);
        return true;
      });
      if (!found) break; handled++;
    }
    return handled;
  }
}

@ApiTags('联系人通知请求') @ApiBearerAuth() @Controller()
export class ContactAlertsController {
  constructor(@Inject(ContactAlertsService) readonly alerts: ContactAlertsService) {}
  @Post('pets/:id/contact-alerts') @HttpCode(202) @Header('Cache-Control', 'no-store') @JsonBody(createBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  create(@CurrentUser() user: string, @Param('id') pet: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.alerts.create(user, pet, body, key); }
  @Get('pets/:id/contact-alerts') @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 200, example: 50 }) @ApiQuery({ name: 'cursor', required: false })
  list(@CurrentUser() user: string, @Param('id') pet: string, @Query() query: unknown) { return this.alerts.list(user, pet, query); }
  @Get('contact-alerts/:id') @Header('Cache-Control', 'no-store')
  get(@CurrentUser() user: string, @Param('id') id: string) { return this.alerts.get(user, id); }
  @Post('contact-alerts/:id/retry') @HttpCode(202) @Header('Cache-Control', 'no-store') @JsonBody(attemptBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  retry(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.alerts.retry(user, id, body, key); }
  @Post('contact-alerts/:id/cancel') @HttpCode(200) @Header('Cache-Control', 'no-store') @JsonBody(attemptBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  cancel(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.alerts.cancel(user, id, body, key); }
}
