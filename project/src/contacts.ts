import { Body, Controller, Delete, Get, Header, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, dateTime, fail, JsonBody, pageQuery } from './http';
import { purgeSourceCopies } from './source-invalidation';
import { invalidateContactAlerts } from './contact-alerts';

const phone = z.string().trim().min(3).max(50).regex(/^[+0-9(). #xX-]+$/).refine(value => /\d/.test(value), '电话号码必须包含数字');
const email = z.email().max(254).transform(value => value.toLowerCase());
const consent = z.object({ status: z.enum(['unknown', 'reported_granted', 'reported_revoked']), note: z.string().trim().max(1000).default('') }).strict();
const fields = z.object({ name: z.string().trim().min(1).max(100), role_description: z.string().trim().max(200), purpose: z.string().trim().max(500),
  phone: phone.nullable(), email: email.nullable(), is_primary: z.boolean(), consent: consent.optional() });
const createBody = fields.extend({ role_description: fields.shape.role_description.default(''), purpose: fields.shape.purpose.default(''),
  phone: fields.shape.phone.default(null), email: fields.shape.email.default(null), is_primary: fields.shape.is_primary.default(false) }).strict()
  .refine(input => input.phone !== null || input.email !== null, '请填写至少一种联系方式');
const updateBody = fields.partial().extend({ expected_version: z.number().int().positive() }).strict()
  .refine(input => Object.keys(input).some(key => key !== 'expected_version'), '请提供待修改字段');
const deleteBody = z.object({ expected_version: z.number().int().positive() }).strict();
const cursorSchema = z.object({ user: z.uuid(), household: z.uuid(), created_at: dateTime, id: z.uuid() });
function present(row: Row): Row {
  const { consent_status, consent_reported_by, consent_reported_at, consent_note, is_primary, ...rest } = row;
  return { ...rest, is_primary: Boolean(is_primary), consent: { status: consent_status, source: 'household_member_reported', verified: false,
    reported_by: consent_reported_by, reported_at: consent_reported_at, note: consent_note } };
}

async function recordContactChange(db: Db, id: string) {
  await invalidateContactAlerts(db, id, 'CONTACT_CHANGED');
  await db.recordDeletion('household_contact_changed', id);
}

export async function deleteHouseholdContact(db: Db, id: string, record = true) {
  return db.transaction(async () => {
    const row = await db.get('SELECT household_id FROM household_contacts WHERE id=?', id);
    const alerts = await invalidateContactAlerts(db, id, 'CONTACT_DELETED', true);
    const affected = await purgeSourceCopies(db, new Set([id]));
    await db.run('DELETE FROM household_contacts WHERE id=?', id);
    if (row && record) await db.recordDeletion('household_contact', id);
    const primary = row ? await db.get('SELECT id FROM household_contacts WHERE household_id=? AND is_primary=1', row.household_id) : null;
    return { deleted: Boolean(row), contact_id: id, primary_contact_id: primary?.id ?? null,
      affected: { idempotency_keys: affected.idempotency_keys + alerts.idempotency_keys, audit_logs: affected.audit_logs + alerts.audit_logs,
        contact_alert_recipients: alerts.affected_rows } };
  });
}

export class ContactsService {
  constructor(@Inject(Db) readonly db: Db) {}
  private async contact(user: string, id: string, write = false): Promise<Row> {
    const row = await this.db.get('SELECT * FROM household_contacts WHERE id=?', id);
    if (!row) fail(404, 'CONTACT_NOT_FOUND', '联系人不存在或已删除');
    await this.db.household(user, row.household_id, write);
    return row;
  }
  private async result(row: Row): Promise<Row> {
    const primary = await this.db.get('SELECT id FROM household_contacts WHERE household_id=? AND is_primary=1', row.household_id);
    return { ...present(row), primary_contact_id: primary?.id ?? null };
  }
  private async replacePrimary(user: string, household: string, id: string) {
    const previous = await this.db.all('SELECT id FROM household_contacts WHERE household_id=? AND id<>? AND is_primary=1', household, id);
    await this.db.run('UPDATE household_contacts SET is_primary=0,version=version+1,updated_by=?,updated_at=? WHERE household_id=? AND id<>? AND is_primary=1', user, this.db.now(), household, id);
    for (const row of previous) await recordContactChange(this.db, row.id);
  }
  async list(user: string, household: string, raw: unknown): Promise<Row> {
    const input = pageQuery.parse(raw);
    return this.db.transaction(async () => {
      await this.db.household(user, household);
      let after: z.infer<typeof cursorSchema> | null = null;
      if (input.cursor) {
        try { after = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
        catch { fail(400, 'INVALID_CURSOR', '联系人分页游标无效'); }
        if (after.user !== user || after.household !== household) fail(400, 'INVALID_CURSOR', '联系人游标不属于当前用户或家庭');
      }
      const rows = await this.db.all(`SELECT * FROM household_contacts WHERE household_id=?
        ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
        household, ...(after ? [after.created_at, after.created_at, after.id] : []), input.limit + 1);
      const last = rows[input.limit - 1], primary = await this.db.get('SELECT id FROM household_contacts WHERE household_id=? AND is_primary=1', household);
      return { household_id: household, items: rows.slice(0, input.limit).map(present), primary_contact_id: primary?.id ?? null,
        next_cursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ user, household, created_at: last.created_at, id: last.id })).toString('base64url') : null };
    });
  }
  async create(user: string, household: string, raw: unknown, key?: string): Promise<Row> {
    const input = createBody.parse(raw);
    return this.db.transaction(async () => {
      await this.db.household(user, household, true);
      const { id } = await this.db.idempotent(user, `POST /households/${household}/contacts`, key, input, async () => {
        const id = this.db.id(), now = this.db.now();
        if (input.is_primary) await this.replacePrimary(user, household, id);
        await this.db.run(`INSERT INTO household_contacts(id,household_id,name,role_description,purpose,phone,email,is_primary,consent_status,consent_reported_by,
          consent_reported_at,consent_note,version,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, household, input.name, input.role_description, input.purpose, input.phone, input.email, Number(input.is_primary), input.consent?.status ?? 'unknown',
          input.consent ? user : null, input.consent ? now : null, input.consent?.note ?? '', 1, user, user, now, now);
        await this.db.audit(user, 'contact.created', id, { household_id: household, is_primary: input.is_primary });
        return { id };
      });
      return this.result(await this.contact(user, id, true));
    });
  }
  async update(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    const input = updateBody.parse(raw);
    return this.db.transaction(async () => {
      const current = await this.contact(user, id, true);
      await this.db.idempotent(user, `PATCH /contacts/${id}`, key, input, async () => {
        if (current.version !== input.expected_version) fail(409, 'VERSION_CONFLICT', '联系人已更新，请重新读取');
        const next: Row = { ...current, ...input }, now = this.db.now();
        if (next.phone === null && next.email === null) fail(400, 'CONTACT_METHOD_REQUIRED', '请保留至少一种联系方式');
        const changed = next.phone !== current.phone || next.email !== current.email;
        const report = input.consent;
        const status = report?.status ?? (changed ? 'unknown' : current.consent_status);
        const reportedBy = report ? user : changed ? null : current.consent_reported_by;
        const reportedAt = report ? now : changed ? null : current.consent_reported_at;
        const note = report ? report.note : changed ? '' : current.consent_note;
        if (next.is_primary) await this.replacePrimary(user, current.household_id, id);
        await this.db.run(`UPDATE household_contacts SET name=?,role_description=?,purpose=?,phone=?,email=?,is_primary=?,consent_status=?,
          consent_reported_by=?,consent_reported_at=?,consent_note=?,version=version+1,updated_by=?,updated_at=? WHERE id=?`,
          next.name, next.role_description, next.purpose, next.phone, next.email, Number(next.is_primary), status, reportedBy, reportedAt, note, user, now, id);
        await recordContactChange(this.db, id);
        await this.db.audit(user, 'contact.updated', id, { household_id: current.household_id, fields: Object.keys(input).filter(field => field !== 'expected_version'), consent_reset: changed && !report });
        return { id };
      });
      return this.result(await this.contact(user, id, true));
    });
  }
  async delete(user: string, id: string, raw: unknown): Promise<Row> {
    const input = deleteBody.parse(raw);
    return this.db.transaction(async () => {
      const current = await this.contact(user, id, true);
      if (current.version !== input.expected_version) fail(409, 'VERSION_CONFLICT', '联系人已更新，请重新读取后删除');
      return deleteHouseholdContact(this.db, id);
    });
  }
}

@ApiTags('家庭联系人') @ApiBearerAuth() @Controller()
export class ContactsController {
  constructor(@Inject(ContactsService) readonly contacts: ContactsService) {}
  @Get('households/:id/contacts') @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'limit', required: false, type: Number }) @ApiQuery({ name: 'cursor', required: false })
  list(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.contacts.list(user, id, query); }
  @Post('households/:id/contacts') @JsonBody(createBody) @ApiHeader({ name: 'Idempotency-Key', required: false }) @Header('Cache-Control', 'no-store')
  create(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.contacts.create(user, id, body, key); }
  @Patch('contacts/:id') @JsonBody(updateBody) @ApiHeader({ name: 'Idempotency-Key', required: false }) @Header('Cache-Control', 'no-store')
  update(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.contacts.update(user, id, body, key); }
  @Delete('contacts/:id') @JsonBody(deleteBody) @Header('Cache-Control', 'no-store')
  delete(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.contacts.delete(user, id, body); }
}
