import { Body, Controller, Get, Header, Headers, Inject, Param, Post, Query, HttpCode, HttpException } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { boundedRange, CurrentUser, dateTime, fail, JsonBody, pageQuery } from './http';
import { settings } from './config';
import { activityWindow, CareService } from './care';
import { timezoneForPet } from './identity';

const label = z.string().trim().min(1).max(100);
const recordBody = z.object({ labels: z.array(label).max(10).default([]).refine(values => new Set(values).size === values.length, '标签不能重复'),
  start_at: dateTime, end_at: dateTime, notes: z.string().max(4000).default(''), media_id: z.uuid().nullable().default(null) }).strict();
const interpretationBody = z.object({ media_id: z.uuid(), behavior_record_id: z.uuid().nullable().default(null), from: dateTime.optional(), to: dateTime.optional(),
  background: z.array(z.enum(['routine_changed', 'not_sure_yet'])).max(2).default([]).refine(values => new Set(values).size === values.length, '背景选项不能重复'),
  notes: z.string().max(4000).default('') }).strict().refine(input => (input.from === undefined) === (input.to === undefined), 'from/to 必须同时提供');
const retryBody = z.object({ expected_attempt: z.number().int().positive() }).strict();
const feedbackBody = z.object({ expected_attempt: z.number().int().positive(), assessment: z.enum(['helpful', 'incorrect', 'other']),
  comment: z.string().trim().min(1).max(4000) }).strict();
const feedbackQuery = pageQuery.extend({ expected_attempt: z.coerce.number().int().positive(), cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
const feedbackCursor = z.object({ user: z.uuid(), interpretation: z.uuid(), attempt: z.number().int().positive(), created_at: dateTime, id: z.uuid() }).strict();
const listQuery = pageQuery.extend({ from: dateTime.optional(), to: dateTime.optional(), label: label.optional(), media_id: z.uuid().optional() });
const recordCursor = z.object({ scope: z.string(), start_at: dateTime, id: z.uuid() });
const taskStatus = z.enum(['pending', 'processing', 'succeeded', 'failed', 'cancelled']);
const taskListQuery = pageQuery.extend({ from: dateTime.optional(), to: dateTime.optional(), status: taskStatus.optional(), media_id: z.uuid().optional() });
const taskScope = z.object({ user: z.string(), pet: z.string(), from: dateTime, to: dateTime, status: taskStatus.nullable(), media_id: z.uuid().nullable() });
const taskCursor = z.object({ scope: taskScope, created_at: dateTime, id: z.uuid() });
const presentRecord = ({ labels_json, ...row }: Row): Row => ({ ...row, labels: JSON.parse(labels_json) });
const presentTask = ({ background_json, result_json, evidence_json, ...row }: Row): Row => ({ ...row,
  background: JSON.parse(background_json), result: result_json === null ? null : JSON.parse(result_json), evidence: JSON.parse(evidence_json) });

export class BehaviorService {
  constructor(@Inject(Db) readonly db: Db) {}
  private window(from: string, to: string) {
    const range = boundedRange(from, to, this.db.clock());
    if (range.to > this.db.now()) fail(400, 'FUTURE_BEHAVIOR_WINDOW', '行为或解释时间窗不能晚于当前时间');
    return range;
  }
  private async media(pet: string, id: string): Promise<Row> {
    const row = await this.db.get('SELECT id,pet_id,sha256,captured_at,duration_seconds FROM pet_media WHERE id=? AND pet_id=?', id, pet);
    if (!row) fail(404, 'MEDIA_NOT_FOUND', '媒体不存在、已删除或不属于本宠物');
    return row;
  }
  async createRecord(user: string, pet: string, raw: unknown, key?: string): Promise<Row> {
    const input = recordBody.parse(raw); this.window(input.start_at, input.end_at);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet, true);
      if (input.media_id) await this.media(pet, input.media_id);
      return this.db.idempotent(user, `POST /pets/${pet}/behavior-records`, key, input, async () => {
        const id = this.db.id();
        await this.db.run(`INSERT INTO behavior_records(id,pet_id,media_id,media_deleted_at,labels_json,start_at,end_at,notes,source,created_by,created_at)
          VALUES (?,?,?,NULL,?,?,?,?,?,?,?)`, id, pet, input.media_id, JSON.stringify(input.labels), input.start_at, input.end_at, input.notes, 'owner_annotation', user, this.db.now());
        await this.db.audit(user, 'behavior.recorded', id, { pet_id: pet });
        return this.record(user, id);
      });
    });
  }
  async record(user: string, id: string): Promise<Row> {
    const row = await this.db.get('SELECT * FROM behavior_records WHERE id=?', id);
    if (!row) fail(404, 'BEHAVIOR_RECORD_NOT_FOUND', '行为记录不存在或已删除');
    await this.db.pet(user, row.pet_id);
    return presentRecord(row);
  }
  async listRecords(user: string, pet: string, raw: unknown): Promise<Row> {
    const input = listQuery.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet);
      const range = boundedRange(input.from, input.to, this.db.clock());
      const scope = JSON.stringify({ user, pet, ...range, label: input.label ?? null, media_id: input.media_id ?? null });
      let after: z.infer<typeof recordCursor> | null = null;
      if (input.cursor) {
        try { after = recordCursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
        catch { fail(400, 'INVALID_CURSOR', '行为记录游标无效'); }
        if (after.scope !== scope) fail(400, 'INVALID_CURSOR', '行为记录游标不属于本次用户或查询范围');
      }
      const labels = this.db.driver === 'postgres' ? 'jsonb_array_elements_text(b.labels_json::jsonb) AS tag(value)' : 'json_each(b.labels_json) AS tag';
      const rows = await this.db.all(`SELECT b.* FROM behavior_records b WHERE b.pet_id=? AND b.start_at<? AND b.end_at>?
        AND (? IS NULL OR b.media_id=?) ${input.label ? `AND EXISTS(SELECT 1 FROM ${labels} WHERE tag.value=?)` : ''}
        ${after ? 'AND (b.start_at<? OR (b.start_at=? AND b.id<?))' : ''} ORDER BY b.start_at DESC,b.id DESC LIMIT ?`,
        pet, range.to, range.from, input.media_id ?? null, input.media_id ?? null, ...(input.label ? [input.label] : []),
        ...(after ? [after.start_at, after.start_at, after.id] : []), input.limit + 1);
      const last = rows[input.limit - 1];
      return { pet_id: pet, ...range, items: rows.slice(0, input.limit).map(presentRecord),
        next_cursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ scope, start_at: last.start_at, id: last.id })).toString('base64url') : null };
    });
  }
  async createInterpretation(user: string, pet: string, raw: unknown, key?: string): Promise<Row> {
    const input = interpretationBody.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet, true); const media = await this.media(pet, input.media_id);
      if (input.behavior_record_id) {
        const behavior = await this.record(user, input.behavior_record_id);
        if (behavior.pet_id !== pet || behavior.media_deleted_at || (behavior.media_id && behavior.media_id !== input.media_id)) fail(400, 'INVALID_BEHAVIOR_REFERENCE', '行为记录必须属于本宠物且引用相同有效媒体');
      }
      if (!input.from && !(Number.isFinite(media.duration_seconds) && media.duration_seconds > 0)) fail(400, 'INTERPRETATION_WINDOW_REQUIRED', '媒体时长未知，请明确提供from/to');
      const from = input.from ?? media.captured_at, to = input.to ?? new Date(Date.parse(media.captured_at) + media.duration_seconds * 1000).toISOString();
      const range = this.window(from, to);
      return this.db.idempotent(user, `POST /pets/${pet}/interpretations`, key, input, async () => {
        const id = this.db.id(), now = this.db.now();
        await this.db.run(`INSERT INTO interpretations(id,pet_id,media_id,behavior_record_id,from_at,to_at,background_json,notes,status,captured_mode,attempt,
          result_json,evidence_json,execution_source,model_version,error_code,created_by,created_at,updated_at,started_at,completed_at)
          VALUES (?,?,?,?,?,?,?,?,'pending',?,1,NULL,'{}',NULL,NULL,NULL,?,?,?,NULL,NULL)`,
          id, pet, input.media_id, input.behavior_record_id, range.from, range.to, JSON.stringify(input.background), input.notes, settings().DATA_MODE, user, now, now);
        await this.db.audit(user, 'interpretation.requested', id, { pet_id: pet });
        return this.interpretation(user, id);
      });
    });
  }
  private async task(user: string, id: string, write = false): Promise<Row> {
    const row = await this.db.get('SELECT * FROM interpretations WHERE id=?', id);
    if (!row) fail(404, 'INTERPRETATION_NOT_FOUND', '解释任务不存在或已删除');
    await this.db.pet(user, row.pet_id, write);
    return row;
  }
  async interpretation(user: string, id: string): Promise<Row> {
    return this.db.transaction(async () => {
      const row = await this.task(user, id);
      if (!row.media_id) return { ...presentTask(row), status: 'failed', result: null, evidence: {}, error_code: 'MEDIA_SOURCE_DELETED' };
      return presentTask(row);
    });
  }
  async listInterpretations(user: string, pet: string, raw: unknown): Promise<Row> {
    const input = taskListQuery.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet);
      let after: z.infer<typeof taskCursor> | null = null;
      if (input.cursor) {
        try { after = taskCursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
        catch { fail(400, 'INVALID_CURSOR', '解释任务游标无效'); }
      }
      const to = input.to ?? after?.scope.to ?? new Date(this.db.clock().getTime() + 1).toISOString();
      const from = input.from ?? after?.scope.from ?? new Date(Date.parse(to) - 31 * 86400000).toISOString(), range = boundedRange(from, to, this.db.clock());
      const scope = { user, pet, ...range, status: input.status ?? null, media_id: input.media_id ?? null };
      if (after && JSON.stringify(after.scope) !== JSON.stringify(scope)) fail(400, 'INVALID_CURSOR', '解释任务游标不属于本次用户或查询范围');
      const effectiveStatus = "CASE WHEN media_id IS NULL THEN 'failed' ELSE status END";
      const rows = await this.db.all(`SELECT id,pet_id,media_id,behavior_record_id,from_at,to_at,status,captured_mode,attempt,execution_source,model_version,error_code,
        created_by,created_at,updated_at,started_at,completed_at,${effectiveStatus} AS effective_status,
        CASE WHEN result_json IS NULL THEN 0 ELSE 1 END AS has_result FROM interpretations WHERE pet_id=? AND created_at>=? AND created_at<?
        AND (? IS NULL OR ${effectiveStatus}=?) AND (? IS NULL OR media_id=?)
        ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
        pet, range.from, range.to, input.status ?? null, input.status ?? null, input.media_id ?? null, input.media_id ?? null,
        ...(after ? [after.created_at, after.created_at, after.id] : []), input.limit + 1);
      const last = rows[input.limit - 1];
      return { pet_id: pet, ...range, status: input.status ?? null, media_id: input.media_id ?? null,
        items: rows.slice(0, input.limit).map(({ effective_status, has_result, ...row }) => ({ ...row, status: effective_status,
          error_code: row.media_id ? row.error_code : 'MEDIA_SOURCE_DELETED', has_result: Boolean(row.media_id && has_result) })),
        next_cursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ scope, created_at: last.created_at, id: last.id })).toString('base64url') : null };
    });
  }
  private async feedbackContext(user: string, id: string, expectedAttempt: number, write: boolean) {
    const task = await this.task(user, id, write);
    if (!task.media_id) fail(409, 'MEDIA_SOURCE_DELETED', '原始媒体已删除，不能提交解释反馈');
    const media = await this.media(task.pet_id, task.media_id);
    if (task.attempt !== expectedAttempt) fail(409, 'ATTEMPT_CONFLICT', '解释尝试已改变，请重读后再反馈');
    if (task.status !== 'succeeded' || task.error_code || !task.result_json) fail(409, 'INTERPRETATION_FEEDBACK_UNAVAILABLE', '仅成功且来源有效的解释可以反馈');
    const prepared = JSON.parse(task.evidence_json), result = JSON.parse(task.result_json);
    if (prepared.id !== `${id}:${task.attempt}` || prepared.media?.id !== task.media_id || prepared.media?.sha256 !== media.sha256 ||
      typeof prepared.window?.timezone !== 'string') fail(409, 'INTERPRETATION_EVIDENCE_UNAVAILABLE', '解释证据已失效');
    const evidence: Row = { source: 'interpretation', interpretation_id: id, attempt: task.attempt, evidence_id: prepared.id, media_id: task.media_id,
      execution_source: task.execution_source, model_version: task.model_version, completed_at: task.completed_at };
    if (typeof result.processing_version === 'string') evidence.processing_version = result.processing_version;
    if (typeof result.is_demo === 'boolean') evidence.is_demo = result.is_demo;
    const featureDate = activityWindow(undefined, prepared.window.timezone, new Date(task.from_at)).date;
    return { task, evidence, featureDate };
  }
  async feedback(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    const input = feedbackBody.parse(raw);
    return this.db.transaction(async () => {
      const { task, evidence, featureDate } = await this.feedbackContext(user, id, input.expected_attempt, true);
      const receipt = await this.db.idempotent(user, `POST /interpretations/${id}/feedback`, key, input, async () => {
        const feedbackId = this.db.id(), now = this.db.now();
        await this.db.run(`INSERT INTO behavior_feedback(id,pet_id,feature_date,assessment,comment,evidence_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`,
          feedbackId, task.pet_id, featureDate, input.assessment, input.comment, JSON.stringify(evidence), user, now);
        await this.db.audit(user, 'interpretation.feedback_submitted', feedbackId, { pet_id: task.pet_id, interpretation_id: id, attempt: task.attempt });
        return { id: feedbackId };
      });
      const saved = await this.db.get('SELECT * FROM behavior_feedback WHERE id=? AND created_by=? AND pet_id=?', receipt.id, user, task.pet_id);
      if (!saved) fail(404, 'FEEDBACK_NOT_FOUND', '反馈不存在或已删除');
      const { evidence_json, ...row } = saved;
      return { ...row, evidence: JSON.parse(evidence_json) };
    });
  }
  async feedbackHistory(user: string, id: string, raw: unknown): Promise<Row> {
    const input = feedbackQuery.parse(raw);
    return this.db.transaction(async () => {
      const { task } = await this.feedbackContext(user, id, input.expected_attempt, false);
      let after: z.infer<typeof feedbackCursor> | null = null;
      if (input.cursor) {
        try { const bytes = Buffer.from(input.cursor, 'base64url'); if (bytes.toString('base64url') !== input.cursor) throw new Error('Invalid encoding'); after = feedbackCursor.parse(JSON.parse(bytes.toString('utf8'))); }
        catch { fail(400, 'INVALID_CURSOR', '解释反馈游标无效'); }
        if (after.user !== user || after.interpretation !== id || after.attempt !== task.attempt) fail(400, 'INVALID_CURSOR', '解释反馈游标不属于当前用户或尝试');
      }
      const field = (name: string) => this.db.driver === 'postgres' ? `evidence_json::jsonb->>'${name}'` : `CAST(json_extract(evidence_json,'$.${name}') AS TEXT)`;
      const rows = await this.db.all(`SELECT * FROM behavior_feedback WHERE created_by=? AND pet_id=?
        AND ${field('source')}='interpretation' AND ${field('interpretation_id')}=? AND ${field('attempt')}=?
        ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
        user, task.pet_id, id, String(task.attempt), ...(after ? [after.created_at, after.created_at, after.id] : []), input.limit + 1);
      const items: Row[] = rows.slice(0, input.limit).map(({ evidence_json, ...row }) => ({ ...row, evidence: JSON.parse(evidence_json) })), last = items.at(-1);
      return { interpretation_id: id, attempt: task.attempt, items, next_cursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ user, interpretation: id, attempt: task.attempt, created_at: last!.created_at, id: last!.id })).toString('base64url') : null };
    });
  }
  async retry(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    const input = retryBody.parse(raw);
    return this.db.transaction(async () => {
      const row = await this.task(user, id, true);
      if (!row.media_id) fail(409, 'MEDIA_SOURCE_DELETED', '来源已删除，不能重试');
      await this.media(row.pet_id, row.media_id);
      return this.db.idempotent(user, `POST /interpretations/${id}/retry`, key, input, async () => {
        if (row.attempt !== input.expected_attempt) fail(409, 'ATTEMPT_CONFLICT', '解释尝试已改变，请重读后再试');
        if (!['failed', 'cancelled'].includes(row.status)) fail(409, 'INTERPRETATION_NOT_RETRYABLE', '仅失败或已取消任务可以重试');
        await this.db.run(`UPDATE interpretations SET status='pending',attempt=attempt+1,captured_mode=?,created_by=?,result_json=NULL,evidence_json='{}',execution_source=NULL,
          model_version=NULL,error_code=NULL,started_at=NULL,completed_at=NULL,updated_at=? WHERE id=?`, settings().DATA_MODE, user, this.db.now(), id);
        await this.db.audit(user, 'interpretation.retried', id, { pet_id: row.pet_id, previous_attempt: row.attempt, previous_status: row.status, previous_requested_by: row.created_by });
        return this.interpretation(user, id);
      });
    });
  }
  async cancel(user: string, id: string, key?: string): Promise<Row> {
    return this.db.transaction(async () => {
      const row = await this.task(user, id, true);
      if (!row.media_id) fail(409, 'MEDIA_SOURCE_DELETED', '来源已删除');
      await this.media(row.pet_id, row.media_id);
      return this.db.idempotent(user, `POST /interpretations/${id}/cancel`, key, {}, async () => {
        if (row.status === 'cancelled') return presentTask(row);
        if (!['pending', 'processing'].includes(row.status)) fail(409, 'INTERPRETATION_NOT_CANCELLABLE', '任务已结束');
        await this.db.run("UPDATE interpretations SET status='cancelled',result_json=NULL,evidence_json='{}',error_code=NULL,completed_at=?,updated_at=? WHERE id=?", this.db.now(), this.db.now(), id);
        await this.db.audit(user, 'interpretation.cancelled', id, { pet_id: row.pet_id, attempt: row.attempt });
        return this.interpretation(user, id);
      });
    });
  }
  async work(limit = 100) {
    z.number().int().positive().max(1000).parse(limit); let processed = 0;
    for (let index = 0; index < limit; index++) {
      const found = await this.db.transaction(async () => {
        const row = await this.db.get("SELECT * FROM interpretations WHERE status='pending' ORDER BY created_at,id LIMIT 1");
        if (!row) return false;
        await this.db.run("UPDATE interpretations SET status='processing',started_at=?,updated_at=? WHERE id=?", this.db.now(), this.db.now(), row.id);
        try {
          await this.db.transaction(async () => {
            if (!row.created_by) fail(403, 'ACTOR_ACCESS_REVOKED', '发起人已不可用');
            const actor = await this.db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', row.created_by);
            if (!actor) fail(403, 'ACTOR_ACCESS_REVOKED', '发起人已不可用');
            try { await this.db.pet(row.created_by, row.pet_id, true); }
            catch (error) {
              if (error instanceof HttpException && [403, 404].includes(error.getStatus())) fail(403, 'ACTOR_ACCESS_REVOKED', '发起人已无写权限');
              throw error;
            }
            if (!row.media_id) fail(409, 'MEDIA_SOURCE_DELETED', '媒体已删除');
            const media = await this.media(row.pet_id, row.media_id);
            if (settings().DATA_MODE !== row.captured_mode) fail(409, 'DATA_MODE_CHANGED', '运行模式已改变');
            if (row.captured_mode === 'api') fail(503, 'MODEL_NOT_CONFIGURED', '未配置解释模型');
            const timezone = await timezoneForPet(this.db, row.pet_id), day = activityWindow(undefined, timezone, new Date(row.from_at));
            const activity = await new CareService(this.db).interval(row.created_by, row.pet_id, { ...day, start: row.from_at, end: row.to_at });
            const evidence = { id: `${row.id}:${row.attempt}`, schema_version: 'interpretation-inputs-v1', evidence_usage: 'prepared_not_model_analyzed', used_by_model: false,
              media: { id: media.id, sha256: media.sha256, captured_at: media.captured_at, duration_seconds: media.duration_seconds },
              window: { from: row.from_at, to: row.to_at, timezone }, activity, behavior_record_id: row.behavior_record_id };
            const result = { is_demo: true, processing_version: 'offline-demo-v1',
              text: '这是离线演示任务结果，未识别或分析音视频，也未推断宠物行为、健康或情绪。', claims: [],
              uncertainty: ['demo_not_media_analysis'], missing_context: ['configured_model', 'wearing_context', 'environment'] };
            await this.db.run(`UPDATE interpretations SET status='succeeded',result_json=?,evidence_json=?,execution_source='offline_demo',model_version=NULL,error_code=NULL,
              completed_at=?,updated_at=? WHERE id=? AND status='processing' AND attempt=?`, JSON.stringify(result), JSON.stringify(evidence), this.db.now(), this.db.now(), row.id, row.attempt);
          });
        } catch (error) {
          const body = error instanceof HttpException ? error.getResponse() : null;
          const code = body && typeof body === 'object' && 'code' in body ? String(body.code) : 'INTERPRETATION_PROCESSING_FAILED';
          await this.db.run("UPDATE interpretations SET status='failed',error_code=?,result_json=NULL,evidence_json='{}',execution_source=NULL,model_version=NULL,completed_at=?,updated_at=? WHERE id=?", code, this.db.now(), this.db.now(), row.id);
        }
        return true;
      });
      if (!found) break; processed++;
    }
    return processed;
  }
}

@ApiTags('行为与解释任务') @ApiBearerAuth() @Controller()
export class BehaviorController {
  constructor(@Inject(BehaviorService) readonly behavior: BehaviorService) {}
  @Post('pets/:id/behavior-records') @JsonBody(recordBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  createRecord(@CurrentUser() user: string, @Param('id') pet: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.behavior.createRecord(user, pet, body, key); }
  @Get('pets/:id/behavior-records') @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'label', required: false }) @ApiQuery({ name: 'media_id', required: false }) @ApiQuery({ name: 'limit', required: false, type: Number }) @ApiQuery({ name: 'cursor', required: false })
  list(@CurrentUser() user: string, @Param('id') pet: string, @Query() query: unknown) { return this.behavior.listRecords(user, pet, query); }
  @Get('behavior-records/:id')
  record(@CurrentUser() user: string, @Param('id') id: string) { return this.behavior.record(user, id); }
  @Post('pets/:id/interpretations') @HttpCode(202) @JsonBody(interpretationBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  create(@CurrentUser() user: string, @Param('id') pet: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.behavior.createInterpretation(user, pet, body, key); }
  @Get('pets/:id/interpretations') @Header('Cache-Control', 'no-store') @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'status', enum: taskStatus.options, required: false }) @ApiQuery({ name: 'media_id', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number }) @ApiQuery({ name: 'cursor', required: false })
  history(@CurrentUser() user: string, @Param('id') pet: string, @Query() query: unknown) { return this.behavior.listInterpretations(user, pet, query); }
  @Get('interpretations/:id')
  interpretation(@CurrentUser() user: string, @Param('id') id: string) { return this.behavior.interpretation(user, id); }
  @Post('interpretations/:id/feedback') @Header('Cache-Control', 'no-store') @JsonBody(feedbackBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  feedback(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.behavior.feedback(user, id, body, key); }
  @Get('interpretations/:id/feedback') @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'expected_attempt', required: true, type: Number }) @ApiQuery({ name: 'limit', required: false, type: Number }) @ApiQuery({ name: 'cursor', required: false })
  feedbackHistory(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.behavior.feedbackHistory(user, id, query); }
  @Post('interpretations/:id/retry') @HttpCode(202) @JsonBody(retryBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  retry(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.behavior.retry(user, id, body, key); }
  @Post('interpretations/:id/cancel') @HttpCode(200) @ApiHeader({ name: 'Idempotency-Key', required: false })
  cancel(@CurrentUser() user: string, @Param('id') id: string, @Headers('idempotency-key') key?: string) { return this.behavior.cancel(user, id, key); }
}
