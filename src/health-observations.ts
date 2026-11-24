import { Controller, Get, Headers, Inject, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { boundedRange, CurrentUser, dateTime, fail, pageQuery } from './http';
import { timezoneSchema } from './identity';

const listQuery = pageQuery.extend({ from: dateTime.optional(), to: dateTime.optional(), timezone: timezoneSchema.optional(),
  read_status: z.enum(['all', 'read', 'unread']).default('all') });
const cursorSchema = z.object({ scope: z.string(), generated_at: dateTime, id: z.uuid() });

export class HealthObservationsService {
  constructor(@Inject(Db) readonly db: Db) {}
  private completed(alias: string) {
    return this.db.driver === 'postgres' ? `(${alias}.result_json::jsonb->>'status')<>'day_in_progress'`
      : `json_extract(${alias}.result_json,'$.status')<>'day_in_progress'`;
  }
  private async present(user: string, row: Row): Promise<Row> {
    const result = JSON.parse(row.result_json);
    const newest = (await this.db.get(`SELECT id FROM activity_observations o
      WHERE pet_id=? AND local_date=? AND timezone=? AND ${this.completed('o')} ORDER BY rowid DESC LIMIT 1`, row.pet_id, row.local_date, row.timezone))!.id;
    return { id: row.id, pet_id: row.pet_id, kind: 'activity_assessment', local_date: row.local_date, timezone: row.timezone,
      generated_at: row.generated_at, rule_version: row.rule_version, finding_count: result.observations.length,
      read_at: (await this.db.get('SELECT read_at FROM health_observation_reads WHERE user_id=? AND observation_id=?', user, row.id))?.read_at ?? null,
      superseded: row.id !== newest,
      content_references: [], assessment: result };
  }
  async list(user: string, pet: string, raw: unknown): Promise<Row> {
    const input = listQuery.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet);
      const to = input.to ?? new Date(this.db.clock().getTime() + 1).toISOString();
      const from = input.from ?? new Date(Date.parse(to) - 31 * 86400000).toISOString();
      const range = boundedRange(from, to, this.db.clock());
      const scope = JSON.stringify({ user, pet, ...range, timezone: input.timezone ?? null, read_status: input.read_status });
      let after: z.infer<typeof cursorSchema> | null = null;
      if (input.cursor) {
        try { after = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
        catch { fail(400, 'INVALID_CURSOR', '健康观察游标无效'); }
        if (after.scope !== scope) fail(400, 'INVALID_CURSOR', '健康观察游标不属于本次用户或查询范围');
      }
      const rows = await this.db.all(`SELECT o.* FROM activity_observations o
        LEFT JOIN health_observation_reads r ON r.observation_id=o.id AND r.user_id=?
        WHERE o.pet_id=? AND o.generated_at>=? AND o.generated_at<? AND ${this.completed('o')}
        AND (? IS NULL OR o.timezone=?) ${input.read_status === 'read' ? 'AND r.read_at IS NOT NULL' : input.read_status === 'unread' ? 'AND r.read_at IS NULL' : ''}
        ${after ? 'AND (o.generated_at<? OR (o.generated_at=? AND o.id<?))' : ''}
        ORDER BY o.generated_at DESC,o.id DESC LIMIT ?`, user, pet, range.from, range.to, input.timezone ?? null, input.timezone ?? null,
        ...(after ? [after.generated_at, after.generated_at, after.id] : []), input.limit + 1);
      const items = await Promise.all(rows.slice(0, input.limit).map(row => this.present(user, row)));
      const last = rows[input.limit - 1];
      return { pet_id: pet, ...range, timezone: input.timezone ?? null, read_status: input.read_status,
        scope: 'saved_completed_day_activity_assessments', items,
        next_cursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ scope, generated_at: last.generated_at, id: last.id })).toString('base64url') : null };
    });
  }
  async detail(user: string, id: string): Promise<Row> {
    return this.db.transaction(async () => {
      const row = await this.db.get(`SELECT * FROM activity_observations o WHERE id=? AND ${this.completed('o')}`, id);
      if (!row) fail(404, 'HEALTH_OBSERVATION_NOT_FOUND', '完整自然日观察不存在或已清理');
      await this.db.pet(user, row.pet_id);
      return this.present(user, row);
    });
  }
  async markRead(user: string, id: string, key?: string): Promise<Row> {
    return this.db.transaction(async () => {
      const observation = await this.detail(user, id);
      return this.db.idempotent(user, `PATCH /health-observations/${id}/read`, key, {}, async () => {
        await this.db.run('INSERT INTO health_observation_reads(user_id,observation_id,read_at) VALUES (?,?,?) ON CONFLICT(user_id,observation_id) DO NOTHING', user, id, this.db.now());
        return { observation_id: id, pet_id: observation.pet_id,
          read_at: (await this.db.get('SELECT read_at FROM health_observation_reads WHERE user_id=? AND observation_id=?', user, id))!.read_at };
      });
    });
  }
}

@ApiTags('健康观察历史') @ApiBearerAuth() @Controller()
export class HealthObservationsController {
  constructor(@Inject(HealthObservationsService) readonly health: HealthObservationsService) {}
  @Get('pets/:id/health-observations') @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'timezone', required: false }) @ApiQuery({ name: 'read_status', enum: ['all', 'read', 'unread'], required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number }) @ApiQuery({ name: 'cursor', required: false })
  list(@CurrentUser() user: string, @Param('id') pet: string, @Query() query: unknown) { return this.health.list(user, pet, query); }
  @Get('health-observations/:id')
  detail(@CurrentUser() user: string, @Param('id') id: string) { return this.health.detail(user, id); }
  @Patch('health-observations/:id/read') @ApiHeader({ name: 'Idempotency-Key', required: false })
  read(@CurrentUser() user: string, @Param('id') id: string, @Headers('idempotency-key') key?: string) { return this.health.markRead(user, id, key); }
}
