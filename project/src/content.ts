import { Body, Controller, Get, Header, Headers, Inject, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, dateTime, fail, JsonBody, pageQuery } from './http';
import { invalidateLessonDerived } from './source-invalidation';

const kind = z.enum(['plan', 'tip', 'guidance', 'lesson']);
const revision = z.number().int().positive();
const text = z.string().trim().min(1);
const review = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('reviewed'), reviewer: text.max(200), reviewed_at: dateTime }).strict(),
]);
const lesson = z.object({
  video: z.object({ url: z.url().max(2000).refine(value => value.startsWith('https://'), '视频地址必须使用HTTPS'), duration_seconds: z.number().positive().max(86400).nullable().default(null) }).strict().nullable().default(null),
  steps: z.array(z.object({ id: text.max(100), title: text.max(200), body: z.string().max(4000).default('') }).strict()).max(100)
    .refine(steps => new Set(steps.map(step => step.id)).size === steps.length, '步骤ID不能重复'),
}).strict();
const exercisePlan = z.object({ walk_minutes: z.number().nonnegative().max(1440), play_minutes: z.number().nonnegative().max(1440), training_minutes: z.number().nonnegative().max(1440) }).strict()
  .refine(value => value.walk_minutes + value.play_minutes + value.training_minutes <= 1440, '计划总时长最多1440分钟');
const contentBody = z.object({
  title: text.max(200), category: text.max(100), summary: z.string().max(2000).default(''), body: text.max(30000),
  applicability: text.max(2000), sources: z.array(z.object({ title: text.max(200), reference: text.max(2000) }).strict()).max(20),
  review, lesson: lesson.nullable().default(null), exercise_plan: exercisePlan.optional(),
}).strict().refine(input => input.review.status !== 'reviewed' || input.sources.length > 0, '已审核内容必须有来源');
const importItem = z.object({ id: z.uuid(), kind, content_version: revision, expected_revision: z.number().int().nonnegative(),
  status: z.enum(['draft', 'published', 'withdrawn']), content: contentBody }).strict()
  .refine(input => input.kind === 'lesson' ? input.content.lesson !== null : input.content.lesson === null, '仅课程需要且必须提供lesson字段')
  .refine(input => input.kind === 'plan' || input.content.exercise_plan === undefined, '仅运动计划可提供exercise_plan')
  .refine(input => input.status !== 'published' || input.content.review.status === 'reviewed', '未审核内容不能发布');
export const contentImportSchema = z.object({ items: z.array(importItem).min(1).max(200) }).strict();
const listQuery = pageQuery.extend({ kind: kind.optional(), category: text.max(100).optional(), q: text.max(100).optional() });
const versionQuery = z.object({ version: z.coerce.number().int().positive().optional() });
const progressBody = z.object({ content_version: revision, completed_step_ids: z.array(text.max(100)).max(100)
  .refine(ids => new Set(ids).size === ids.length, '完成步骤不能重复'), learned: z.boolean(), expected_version: z.number().int().nonnegative() }).strict();

function cursor(raw: string | undefined, scope: Row): Row | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (JSON.stringify(saved.scope) !== JSON.stringify(scope) || !z.uuid().safeParse(saved.id).success || (saved.version !== undefined && !revision.safeParse(saved.version).success)) throw new Error();
    return saved;
  } catch { return fail(400, 'INVALID_CURSOR', '游标不属于当前用户或查询范围'); }
}
const nextCursor = (scope: Row, row: Row, version?: number) => Buffer.from(JSON.stringify({ scope, id: row.id ?? row.content_id, ...(version === undefined ? {} : { version }) })).toString('base64url');
const presentProgress = ({ completed_step_ids_json, learned, ...row }: Row): Row => ({ ...row, completed_step_ids: JSON.parse(completed_step_ids_json), learned: Boolean(learned) });

export async function importContent(db: Db, raw: unknown): Promise<Row> {
  const input = contentImportSchema.parse(raw);
  return db.transaction(async () => {
    const items: Row[] = [];
    for (const entry of input.items) {
      if (entry.content.review.status === 'reviewed' && entry.content.review.reviewed_at > db.now()) fail(400, 'FUTURE_CONTENT_REVIEW', '审核时间不能晚于当前时间');
      const current = await db.get('SELECT * FROM content_items WHERE id=?', entry.id);
      if ((current?.revision ?? 0) !== entry.expected_revision) fail(409, 'VERSION_CONFLICT', '内容目录版本已改变，请重新读取后导入');
      if (current && current.kind !== entry.kind) fail(409, 'CONTENT_KIND_IMMUTABLE', '同一内容ID不能更改类型');
      if (current && entry.content_version < current.current_version) fail(409, 'CONTENT_VERSION_REGRESSION', '当前内容不能回退到旧版本');
      const payload = JSON.stringify(entry.content), existing = await db.get('SELECT payload_json,publication_status FROM content_versions WHERE content_id=? AND version=?', entry.id, entry.content_version);
      if (existing && existing.payload_json !== payload) fail(409, 'CONTENT_VERSION_IMMUTABLE', '相同内容版本的正文、来源及审核资料不能修改');
      if (current?.current_version === entry.content_version && current.status === entry.status && existing?.publication_status === entry.status) {
        items.push({ id: entry.id, content_version: entry.content_version, revision: current.revision, status: current.status });
        continue;
      }
      const updated = db.now(), catalogRevision = entry.expected_revision + 1;
      await db.run(`INSERT INTO content_items(id,kind,current_version,status,revision,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET current_version=excluded.current_version,status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at`,
        entry.id, entry.kind, entry.content_version, entry.status, catalogRevision, updated);
      if (entry.status !== 'published') {
        await db.run("UPDATE content_versions SET publication_status='withdrawn' WHERE content_id=? AND publication_status='published'", entry.id);
        await invalidateLessonDerived(db, entry.id);
      }
      if (!existing) await db.run('INSERT INTO content_versions(content_id,version,title,category,payload_json,created_at,publication_status) VALUES (?,?,?,?,?,?,?)', entry.id, entry.content_version, entry.content.title, entry.content.category, payload, updated, entry.status);
      else await db.run('UPDATE content_versions SET publication_status=? WHERE content_id=? AND version=?', entry.status, entry.id, entry.content_version);
      await db.audit(null, 'content.imported', entry.id, { content_version: entry.content_version, catalog_revision: catalogRevision, status: entry.status });
      items.push({ id: entry.id, content_version: entry.content_version, revision: catalogRevision, status: entry.status });
    }
    return { items };
  });
}

export class ContentService {
  constructor(@Inject(Db) readonly db: Db) {}
  private present(row: Row): Row {
    return { id: row.id, kind: row.kind, content_version: row.version, current_version: row.current_version, catalog_revision: row.revision, ...JSON.parse(row.payload_json), created_at: row.created_at, updated_at: row.updated_at };
  }
  private async visible(id: string, requested?: number, lessonsOnly = false): Promise<Row> {
    const row = await this.db.get(`SELECT i.*,v.version,v.payload_json,v.created_at FROM content_items i JOIN content_versions v ON v.content_id=i.id
      AND v.version=COALESCE(?,i.current_version) WHERE i.id=? AND i.status='published' AND v.publication_status='published'`, requested ?? null, id);
    if (!row || (lessonsOnly && row.kind !== 'lesson') || JSON.parse(row.payload_json).review.status !== 'reviewed') fail(404, 'CONTENT_NOT_FOUND', '内容不存在或尚未发布');
    return row;
  }
  private async progress(user: string, id: string, version: number) {
    const row = await this.db.get('SELECT * FROM learning_progress WHERE user_id=? AND content_id=? AND content_version=?', user, id, version);
    return row ? presentProgress(row) : { content_id: id, content_version: version, completed_step_ids: [], learned: false, learned_at: null, version: 0, updated_at: null };
  }
  async list(user: string, raw: unknown, lessonsOnly = false): Promise<Row> {
    const input = listQuery.parse(raw);
    if (lessonsOnly && input.kind && input.kind !== 'lesson') fail(400, 'INVALID_CONTENT_KIND', '课程目录仅支持lesson类型');
    const selectedKind = lessonsOnly ? 'lesson' : input.kind ?? null;
    const scope = { user, kind: selectedKind, category: input.category ?? null, q: input.q ?? null }, after = cursor(input.cursor, scope);
    const needle = input.q ? `%${input.q.toLowerCase().replace(/[\\%_]/g, value => `\\${value}`)}%` : null;
    return this.db.transaction(async () => {
      const rows = await this.db.all(`SELECT i.*,v.version,v.payload_json,v.created_at FROM content_items i
        JOIN content_versions v ON v.content_id=i.id AND v.version=i.current_version WHERE i.status='published' AND v.publication_status='published'
        AND (? IS NULL OR i.kind=?) AND (? IS NULL OR v.category=?) AND (? IS NULL OR LOWER(v.title) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR i.id>?) ORDER BY i.id LIMIT ?`, selectedKind, selectedKind, input.category ?? null, input.category ?? null, needle, needle, after?.id ?? null, after?.id ?? null, input.limit + 1);
      const items = await Promise.all(rows.slice(0, input.limit).map(async row => ({ ...this.present(row), ...(row.kind === 'lesson' ? { progress: await this.progress(user, row.id, row.version) } : {}) })));
      return { items, next_cursor: rows.length > input.limit ? nextCursor(scope, rows[input.limit - 1]) : null, search_scope: 'title_substring' };
    });
  }
  async detail(user: string, id: string, raw: unknown, lessonsOnly = false): Promise<Row> {
    const query = versionQuery.parse(raw);
    return this.db.transaction(async () => {
      const row = await this.visible(id, query.version, lessonsOnly);
      return { ...this.present(row), ...(row.kind === 'lesson' ? { progress: await this.progress(user, id, row.version) } : {}) };
    });
  }
  async putProgress(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    const parsed = progressBody.parse(raw), input = { ...parsed, completed_step_ids: [...parsed.completed_step_ids].sort() };
    return this.db.transaction(async () => {
      const item = await this.visible(id, undefined, true);
      if (item.current_version !== input.content_version) fail(409, 'CONTENT_VERSION_CHANGED', '课程已更新，请重读当前课程版本');
      const allowed = new Set<string>(JSON.parse(item.payload_json).lesson.steps.map((step: Row) => step.id));
      if (input.completed_step_ids.some(step => !allowed.has(step))) fail(400, 'INVALID_LESSON_STEP', '完成步骤不属于该课程版本');
      return this.db.idempotent(user, `PUT /lessons/${id}/progress`, key, input, async () => {
        const current = await this.progress(user, id, input.content_version);
        if (current.version !== input.expected_version) fail(409, 'VERSION_CONFLICT', '学习记录已改变，请重新读取');
        const now = this.db.now(), learnedAt = input.learned ? current.learned_at ?? now : null;
        await this.db.run(`INSERT INTO learning_progress(user_id,content_id,content_version,completed_step_ids_json,learned,learned_at,version,updated_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(user_id,content_id,content_version) DO UPDATE SET completed_step_ids_json=excluded.completed_step_ids_json,learned=excluded.learned,learned_at=excluded.learned_at,version=excluded.version,updated_at=excluded.updated_at`,
          user, id, input.content_version, JSON.stringify(input.completed_step_ids), Number(input.learned), learnedAt, current.version + 1, now);
        await this.db.audit(user, 'learning.progress_saved', id, { content_version: input.content_version, version: current.version + 1 });
        return this.progress(user, id, input.content_version);
      });
    });
  }
  async learning(user: string, raw: unknown): Promise<Row> {
    const input = pageQuery.parse(raw), scope = { user, section: 'learning-progress' }, after = cursor(input.cursor, scope);
    if (after && !revision.safeParse(after.version).success) fail(400, 'INVALID_CURSOR', '学习记录游标缺少课程版本');
    return this.db.transaction(async () => {
      const rows = await this.db.all(`SELECT p.*,i.current_version,i.status,v.title,v.payload_json,v.publication_status FROM learning_progress p
        JOIN content_items i ON i.id=p.content_id JOIN content_versions v ON v.content_id=p.content_id AND v.version=p.content_version
        WHERE p.user_id=? AND (? IS NULL OR p.content_id>? OR (p.content_id=? AND p.content_version>?))
        ORDER BY p.content_id,p.content_version LIMIT ?`, user, after?.id ?? null, after?.id ?? null, after?.id ?? null, after?.version ?? 0, input.limit + 1);
      const counts = (await this.db.get(`SELECT COUNT(*) AS available_count,COALESCE(SUM(CASE WHEN p.learned=1 THEN 1 ELSE 0 END),0) AS learned_count FROM content_items i
        JOIN content_versions v ON v.content_id=i.id AND v.version=i.current_version AND v.publication_status='published'
        LEFT JOIN learning_progress p ON p.content_id=i.id AND p.content_version=i.current_version AND p.user_id=? WHERE i.kind='lesson' AND i.status='published'`, user))!;
      const items = rows.slice(0, input.limit).map(({ current_version, status, title, payload_json, publication_status, ...row }) => ({ ...presentProgress(row),
        current_content_version: current_version, content_status: status !== 'published' || publication_status !== 'published' ? 'unavailable' : row.content_version === current_version ? 'current' : 'updated',
        title: status === 'published' && publication_status === 'published' && JSON.parse(payload_json).review.status === 'reviewed' ? title : null }));
      return { items, next_cursor: rows.length > input.limit ? nextCursor(scope, rows[input.limit - 1], rows[input.limit - 1].content_version) : null,
        counts: { scope: 'all_current_published_lessons', available_count: counts.available_count, learned_count: counts.learned_count }, completion_basis: 'user_declared_learned' };
    });
  }
}

@ApiTags('内容与本人学习') @ApiBearerAuth() @Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}
  @Get('content') @ApiQuery({ name: 'kind', enum: kind.options, required: false }) @ApiQuery({ name: 'category', required: false }) @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false, type: Number })
  list(@CurrentUser() user: string, @Query() query: unknown) { return this.content.list(user, query); }
  @Get('content/:id') @ApiQuery({ name: 'version', required: false, type: Number })
  detail(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.content.detail(user, id, query); }
  @Get('lessons') @ApiQuery({ name: 'category', required: false }) @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false, type: Number })
  lessons(@CurrentUser() user: string, @Query() query: unknown) { return this.content.list(user, query, true); }
  @Get('lessons/:id') @ApiQuery({ name: 'version', required: false, type: Number })
  lesson(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.content.detail(user, id, query, true); }
  @Get('learning-progress') @Header('Cache-Control', 'no-store') @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false, type: Number })
  learning(@CurrentUser() user: string, @Query() query: unknown) { return this.content.learning(user, query); }
  @Put('lessons/:id/progress') @JsonBody(progressBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  progress(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.content.putProgress(user, id, body, key); }
}
