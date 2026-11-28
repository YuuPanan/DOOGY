import { Body, Controller, Get, Headers, HttpCode, HttpException, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { settings } from './config';
import { CurrentUser, fail, JsonBody, pageQuery } from './http';
import { CareService } from './care';
import { WellnessService } from './wellness';
import { NutritionService } from './nutrition';
import { ContentService } from './content';

const conversationBody = z.object({ title: z.string().trim().min(1).max(200).default('新的问答') }).strict();
const contextBody = z.object({ kind: z.enum(['activity', 'body_check_in', 'nutrition', 'lesson', 'behavior']).default('activity'),
  date: z.iso.date().optional(), timezone: z.string().max(100).optional(),
  lesson_id: z.uuid().optional(), lesson_version: z.number().int().positive().optional(),
  behavior_record_id: z.uuid().optional(), interpretation_id: z.uuid().optional(),
  background: z.array(z.enum(['routine_changed', 'not_sure_yet'])).max(2).default([]), notes: z.string().max(2000).default('') }).strict()
  .superRefine((input, ctx) => {
    if (input.kind === 'lesson' && (!input.lesson_id || !input.lesson_version)) ctx.addIssue({ code: 'custom', message: '课程上下文需要ID及版本' });
    if (input.kind !== 'lesson' && (input.lesson_id || input.lesson_version)) ctx.addIssue({ code: 'custom', message: '仅课程上下文可引用课程' });
    const references = Number(Boolean(input.behavior_record_id)) + Number(Boolean(input.interpretation_id));
    if (input.kind === 'behavior' ? references !== 1 : references > 0) ctx.addIssue({ code: 'custom', message: '行为上下文需且仅可引用一条行为或解释' });
  });
const messageBody = z.object({ question: z.string().trim().min(1).max(4000), context: contextBody.default({ kind: 'activity', background: [], notes: '' }) }).strict();
const retryBody = z.object({ expected_attempt: z.number().int().positive() }).strict();
const cursorSchema = z.object({ scope: z.string(), created_at: z.string(), id: z.uuid() });
const invalidated = (error: string | null) => Boolean(error && ['MEDIA_SOURCE_DELETED', 'EVIDENCE_EXPIRED', 'ACTIVITY_SOURCE_EXPIRED', 'CARE_SOURCE_WITHDRAWN', 'CARE_SOURCE_CHANGED', 'CARE_RECORD_WITHDRAWN', 'SOURCE_INVALIDATED', 'CONTENT_UNAVAILABLE', 'ACCESS_REVOKED'].includes(error));
function cursor(raw: string | undefined, scope: string) {
  if (!raw) return null;
  try {
    const saved = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (saved.scope !== scope) throw new Error();
    return saved;
  } catch { return fail(400, 'INVALID_CURSOR', '问答游标不属于本次用户或范围'); }
}
function paged(rows: Row[], limit: number, scope: string) {
  return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({ scope, created_at: rows[limit - 1].created_at, id: rows[limit - 1].id })).toString('base64url') : null };
}

export class AssistantService {
  constructor(@Inject(Db) readonly db: Db) {}
  private async authorize(user: string, id: string) {
    const row = await this.db.get('SELECT * FROM assistant_conversations WHERE id=? AND user_id=?', id, user);
    if (!row) fail(404, 'CONVERSATION_NOT_FOUND', '问答会话不存在');
    await this.db.pet(user, row.pet_id);
    return row;
  }
  async createConversation(user: string, pet: string, raw: unknown, key?: string): Promise<Row> {
    const input = conversationBody.parse(raw ?? {});
    return this.db.transaction(async () => {
      await this.db.pet(user, pet);
      const { id } = await this.db.idempotent(user, `POST /pets/${pet}/assistant-conversations`, key, input, async () => {
        const id = this.db.id(), now = this.db.now();
        await this.db.run('INSERT INTO assistant_conversations VALUES (?,?,?,?,?,?)', id, user, pet, input.title, now, now);
        return { id };
      });
      return this.authorize(user, id);
    });
  }
  async conversations(user: string, pet: string, raw: unknown): Promise<Row> {
    const input = pageQuery.parse(raw), scope = JSON.stringify({ user, pet, kind: 'assistant-conversations' }), after = cursor(input.cursor, scope);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet);
      return paged(await this.db.all(`SELECT * FROM assistant_conversations WHERE user_id=? AND pet_id=?
        ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`, user, pet,
        ...(after ? [after.created_at, after.created_at, after.id] : []), input.limit + 1), input.limit, scope);
    });
  }
  private async prepare(user: string, pet: string, context: z.infer<typeof contextBody>): Promise<Row> {
    const period = { date: context.date, timezone: context.timezone }, prepared_at = this.db.now();
    const base = { prepared_at, used_by_model: false, evidence_usage: 'prepared_not_model_analyzed', kind: context.kind };
    if (context.kind === 'activity') {
      const summary = await new CareService(this.db).daily(user, pet, period);
      const samples = await this.db.all('SELECT id FROM activity_samples WHERE pet_id=? AND start_at<? AND end_at>? ORDER BY start_at,id LIMIT 10001', pet, summary.period_end, summary.period_start);
      if (samples.length > 10000) fail(400, 'CONTEXT_TOO_LARGE', '所选日期的活动样本过多');
      return { media_id: null, evidence: { ...base, summary, sample_ids: samples.map(row => row.id), missing_context: summary.sample_count ? [] : ['activity_missing'] } };
    }
    if (context.kind === 'body_check_in') {
      const check = await new WellnessService(this.db).checkIn(user, pet, period);
      return { media_id: null, evidence: { ...base, check_in: check, source_record_ids: check.toileting_record_id ? [check.toileting_record_id] : [], missing_context: check.version ? [] : ['body_check_in_missing'] } };
    }
    if (context.kind === 'nutrition') {
      const daily = await new NutritionService(this.db).daily(user, pet, period);
      if (daily.items.length > 10000) fail(400, 'CONTEXT_TOO_LARGE', '所选日期的喂食记录过多');
      return { media_id: null, evidence: { ...base, local_date: daily.local_date, timezone: daily.timezone, period_start: daily.period_start, period_end: daily.period_end,
        known_kcal: daily.known_kcal, target_kcal: daily.target_kcal, goal_id: daily.goal_id, goal_version: daily.goal_version,
        goal_effective_date: daily.goal_effective_date, record_count: daily.record_count, unknown_energy_count: daily.unknown_energy_count,
        source_record_ids: daily.items.map((row: Row) => row.id),
        completeness: daily.completeness, missing_context: daily.unknown_energy_count ? ['unknown_meal_energy'] : daily.record_count ? [] : ['feeding_missing'] } };
    }
    if (context.kind === 'lesson') {
      const lesson = await new ContentService(this.db).detail(user, context.lesson_id!, { version: context.lesson_version }, true);
      return { media_id: null, evidence: { ...base, lesson: { id: lesson.id, content_version: lesson.content_version, title: lesson.title, review: lesson.review, sources: lesson.sources }, missing_context: [] } };
    }
    const row = context.behavior_record_id ? await this.db.get('SELECT * FROM behavior_records WHERE id=? AND pet_id=?', context.behavior_record_id, pet)
      : await this.db.get('SELECT * FROM interpretations WHERE id=? AND pet_id=?', context.interpretation_id!, pet);
    if (!row) fail(404, 'BEHAVIOR_CONTEXT_NOT_FOUND', '所选行为上下文不属于本宠物');
    if (context.interpretation_id && (row.status !== 'succeeded' || !row.result_json || invalidated(row.error_code))) fail(409, 'BEHAVIOR_CONTEXT_UNAVAILABLE', '所选解释尚不可用');
    if (context.behavior_record_id && !row.media_id && !row.media_deleted_at) return { media_id: null, evidence: { ...base,
      reference: { kind: 'owner_annotation', id: row.id, labels: JSON.parse(row.labels_json), start_at: row.start_at, end_at: row.end_at, notes: row.notes },
      media: null, missing_context: ['media_not_provided', 'no_model_inference'] } };
    if (!row.media_id) fail(409, 'MEDIA_SOURCE_UNAVAILABLE', '所选行为没有有效媒体');
    const media = await this.db.get('SELECT id,sha256,duration_seconds FROM pet_media WHERE id=? AND pet_id=?', row.media_id, pet);
    if (!media) fail(409, 'MEDIA_SOURCE_UNAVAILABLE', '引用媒体已删除');
    return { media_id: media.id, evidence: { ...base, media: { ...media, analyzed: false },
      reference: context.behavior_record_id ? { kind: 'owner_annotation', id: row.id, labels: JSON.parse(row.labels_json), start_at: row.start_at, end_at: row.end_at }
        : { kind: 'interpretation', id: row.id, attempt: row.attempt, execution_source: row.execution_source, model_version: row.model_version }, missing_context: ['no_media_model_configured'] } };
  }
  async postMessage(user: string, conversation: string, raw: unknown, key?: string): Promise<Row> {
    const input = messageBody.parse(raw);
    return this.db.transaction(async () => {
      const owner = await this.authorize(user, conversation);
      const { id } = await this.db.idempotent(user, `POST /assistant-conversations/${conversation}/messages`, key, input, async () => {
        const prepared = await this.prepare(user, owner.pet_id, input.context), id = this.db.id(), now = this.db.now();
        await this.db.run(`INSERT INTO assistant_messages(id,conversation_id,question,context_json,evidence_json,media_id,behavior_record_id,interpretation_id,lesson_id,lesson_version,
          status,captured_mode,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, conversation, input.question, JSON.stringify(input.context), JSON.stringify(prepared.evidence),
          prepared.media_id, input.context.behavior_record_id ?? null, input.context.interpretation_id ?? null, input.context.lesson_id ?? null, input.context.lesson_version ?? null,
          'pending', settings().DATA_MODE, 1, now, now);
        await this.db.audit(user, 'assistant.message_requested', id, { pet_id: owner.pet_id, context_kind: input.context.kind });
        await this.db.run('UPDATE assistant_conversations SET updated_at=? WHERE id=?', now, conversation);
        return { id };
      });
      return this.message(user, id);
    });
  }
  private async invalidate(id: string, code: string) {
    await this.db.run("UPDATE assistant_messages SET status='failed',context_json='{}',evidence_json='{}',result_json=NULL,error_code=?,execution_source=NULL,model_version=NULL,updated_at=?,completed_at=? WHERE id=?", code, this.db.now(), this.db.now(), id);
  }
  private async checkSources(row: Row) {
    if (invalidated(row.error_code)) return;
    if (row.media_id && !await this.db.get('SELECT id FROM pet_media WHERE id=? AND pet_id=?', row.media_id, row.pet_id)) return this.invalidate(row.id, 'MEDIA_SOURCE_DELETED');
    if (row.lesson_id) {
      try { await new ContentService(this.db).detail(row.user_id, row.lesson_id, { version: row.lesson_version }, true); }
      catch (error) {
        if (error instanceof HttpException && error.getStatus() === 404) return this.invalidate(row.id, 'CONTENT_UNAVAILABLE');
        throw error;
      }
    }
    const evidence = JSON.parse(row.evidence_json);
    if (row.behavior_record_id) {
      const record = await this.db.get('SELECT media_id,media_deleted_at FROM behavior_records WHERE id=? AND pet_id=?', row.behavior_record_id, row.pet_id);
      if (!record || record.media_deleted_at || record.media_id !== row.media_id) return this.invalidate(row.id, 'SOURCE_INVALIDATED');
    }
    if (row.interpretation_id) {
      const task = await this.db.get('SELECT status,attempt FROM interpretations WHERE id=? AND pet_id=?', row.interpretation_id, row.pet_id);
      if (!task || task.status !== 'succeeded' || task.attempt !== evidence.reference?.attempt) return this.invalidate(row.id, 'SOURCE_INVALIDATED');
    }
    if (evidence.sample_ids?.length) {
      const n = (await this.db.get(`SELECT COUNT(*) AS n FROM activity_samples WHERE pet_id=? AND id IN (${evidence.sample_ids.map(() => '?').join(',')})`, row.pet_id, ...evidence.sample_ids))!.n;
      if (n !== evidence.sample_ids.length) return this.invalidate(row.id, 'EVIDENCE_EXPIRED');
    }
    if (evidence.source_record_ids?.length) {
      const n = (await this.db.get(`SELECT COUNT(*) AS n FROM care_records WHERE pet_id=? AND withdrawn_at IS NULL AND id IN (${evidence.source_record_ids.map(() => '?').join(',')})`, row.pet_id, ...evidence.source_record_ids))!.n;
      if (n !== evidence.source_record_ids.length) return this.invalidate(row.id, 'CARE_RECORD_WITHDRAWN');
    }
  }
  private present(row: Row): Row {
    const { context_json, evidence_json, result_json, user_id, pet_id, ...rest } = row;
    return { ...rest, pet_id, context: JSON.parse(context_json), evidence: JSON.parse(evidence_json), result: result_json ? JSON.parse(result_json) : null };
  }
  async message(user: string, id: string): Promise<Row> {
    return this.db.transaction(async () => {
      let row = await this.db.get(`SELECT m.*,c.user_id,c.pet_id FROM assistant_messages m JOIN assistant_conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.user_id=?`, id, user);
      if (!row) fail(404, 'ASSISTANT_MESSAGE_NOT_FOUND', '问答记录不存在');
      await this.db.pet(user, row.pet_id);
      await this.checkSources(row);
      row = { ...row, ...(await this.db.get('SELECT * FROM assistant_messages WHERE id=?', id))! };
      return this.present(row);
    });
  }
  async messages(user: string, conversation: string, raw: unknown): Promise<Row> {
    const input = pageQuery.parse(raw), scope = JSON.stringify({ user, conversation, kind: 'assistant-messages' }), after = cursor(input.cursor, scope);
    return this.db.transaction(async () => {
      await this.authorize(user, conversation);
      const page = paged(await this.db.all(`SELECT id,created_at FROM assistant_messages WHERE conversation_id=?
        ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`, conversation,
        ...(after ? [after.created_at, after.created_at, after.id] : []), input.limit + 1), input.limit, scope);
      const items: Row[] = [];
      for (const item of page.items) items.push(await this.message(user, item.id));
      return { ...page, items };
    });
  }
  async retry(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    const input = retryBody.parse(raw);
    return this.db.transaction(async () => {
      const row = await this.message(user, id);
      if (invalidated(row.error_code)) fail(409, 'SOURCE_INVALIDATED', '原始来源已失效，请重新提问');
      await this.db.idempotent(user, `POST /assistant-messages/${id}/retry`, key, input, async () => {
        if (!['failed', 'cancelled'].includes(row.status) || row.attempt !== input.expected_attempt) fail(409, 'TASK_STATE_CONFLICT', '任务状态或尝试版本已改变');
        await this.db.run("UPDATE assistant_messages SET status='pending',captured_mode=?,attempt=attempt+1,result_json=NULL,error_code=NULL,execution_source=NULL,model_version=NULL,started_at=NULL,completed_at=NULL,updated_at=? WHERE id=?", settings().DATA_MODE, this.db.now(), id);
        await this.db.audit(user, 'assistant.message_retried', id, { previous_attempt: row.attempt, previous_mode: row.captured_mode });
        return { id };
      });
      return this.message(user, id);
    });
  }
  async cancel(user: string, id: string, key?: string): Promise<Row> {
    return this.db.transaction(async () => {
      const row = await this.message(user, id);
      await this.db.idempotent(user, `POST /assistant-messages/${id}/cancel`, key, {}, async () => {
        if (row.status === 'cancelled') return { id };
        if (!['pending', 'processing'].includes(row.status)) fail(409, 'TASK_STATE_CONFLICT', '已结束的任务不能取消');
        await this.db.run("UPDATE assistant_messages SET status='cancelled',result_json=NULL,completed_at=?,updated_at=? WHERE id=?", this.db.now(), this.db.now(), id);
        await this.db.audit(user, 'assistant.message_cancelled', id, { attempt: row.attempt });
        return { id };
      });
      return this.message(user, id);
    });
  }
  async work(limit = 10) {
    const pending = await this.db.all("SELECT id FROM assistant_messages WHERE status='pending' ORDER BY created_at,id LIMIT ?", limit);
    let handled = 0;
    for (const item of pending) handled += await this.db.transaction(async () => {
      const row = await this.db.get(`SELECT m.*,c.user_id,c.pet_id,u.closed_at FROM assistant_messages m
        JOIN assistant_conversations c ON c.id=m.conversation_id JOIN users u ON u.id=c.user_id WHERE m.id=? AND m.status='pending'`, item.id);
      if (!row) return 0;
      const allowed = !row.closed_at && await this.db.get('SELECT 1 FROM household_members WHERE user_id=? AND household_id=(SELECT household_id FROM pets WHERE id=?)', row.user_id, row.pet_id);
      if (!allowed) { await this.invalidate(row.id, 'ACCESS_REVOKED'); return 1; }
      await this.checkSources(row);
      if ((await this.db.get('SELECT status FROM assistant_messages WHERE id=?', row.id))?.status !== 'pending') return 1;
      await this.db.run("UPDATE assistant_messages SET status='processing',started_at=?,updated_at=? WHERE id=?", this.db.now(), this.db.now(), row.id);
      if (row.captured_mode !== settings().DATA_MODE) {
        await this.db.run("UPDATE assistant_messages SET status='failed',error_code='DATA_MODE_CHANGED',completed_at=?,updated_at=? WHERE id=?", this.db.now(), this.db.now(), row.id);
      } else if (row.captured_mode === 'api') {
        await this.db.run("UPDATE assistant_messages SET status='failed',error_code='MODEL_NOT_CONFIGURED',completed_at=?,updated_at=? WHERE id=?", this.db.now(), this.db.now(), row.id);
      } else {
        const result = { text: '离线固定演示：已保存问题及可读取的上下文引用。本演示没有调用模型，没有识别音视频，也不提供个体健康或情绪结论。',
          simulated: true, execution_source: 'offline_demo', demo_version: 'assistant-demo-v1', model_version: null,
          evidence_usage: 'prepared_not_model_analyzed', uncertainty: ['no_model_inference'], missing_context: JSON.parse(row.evidence_json).missing_context ?? [] };
        await this.db.run("UPDATE assistant_messages SET status='succeeded',result_json=?,execution_source='offline_demo',model_version=NULL,error_code=NULL,completed_at=?,updated_at=? WHERE id=? AND status='processing'",
          JSON.stringify(result), this.db.now(), this.db.now(), row.id);
      }
      return 1;
    });
    return handled;
  }
}

@ApiTags('本人宠物问答') @ApiBearerAuth() @Controller()
export class AssistantController {
  constructor(@Inject(AssistantService) readonly assistant: AssistantService) {}
  @Post('pets/:id/assistant-conversations') @JsonBody(conversationBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  create(@CurrentUser() user: string, @Param('id') pet: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.assistant.createConversation(user, pet, body, key); }
  @Get('pets/:id/assistant-conversations') @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false, type: Number })
  conversations(@CurrentUser() user: string, @Param('id') pet: string, @Query() query: unknown) { return this.assistant.conversations(user, pet, query); }
  @Post('assistant-conversations/:id/messages') @HttpCode(202) @JsonBody(messageBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  post(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.assistant.postMessage(user, id, body, key); }
  @Get('assistant-conversations/:id/messages') @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false, type: Number })
  messages(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.assistant.messages(user, id, query); }
  @Get('assistant-messages/:id')
  message(@CurrentUser() user: string, @Param('id') id: string) { return this.assistant.message(user, id); }
  @Post('assistant-messages/:id/retry') @HttpCode(202) @JsonBody(retryBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  retry(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.assistant.retry(user, id, body, key); }
  @Post('assistant-messages/:id/cancel') @HttpCode(200) @ApiHeader({ name: 'Idempotency-Key', required: false })
  cancel(@CurrentUser() user: string, @Param('id') id: string, @Headers('idempotency-key') key?: string) { return this.assistant.cancel(user, id, key); }
}
