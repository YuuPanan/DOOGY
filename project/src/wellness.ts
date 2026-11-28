import { Body, Controller, Get, Headers, Inject, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { boundedRange, CurrentUser, dateTime, fail, JsonBody, pageQuery } from './http';
import { timezoneForPet } from './identity';
import { activityWindow, CareService } from './care';

const date = z.iso.date();
const period = z.object({ date: date.optional(), timezone: z.string().optional() });
const targets = z.object({ active_minutes: z.number().positive().max(1440).nullable().default(null),
  steps: z.number().int().positive().max(1000000).nullable().default(null),
  intake_kcal: z.number().positive().max(100000).nullable().default(null) });
const plan = z.object({ name: z.string().trim().min(1).max(200), content_version: z.string().trim().min(1).max(100),
  walk_minutes: z.number().nonnegative().max(1440), play_minutes: z.number().nonnegative().max(1440),
  training_minutes: z.number().nonnegative().max(1440) }).refine(p => p.walk_minutes + p.play_minutes + p.training_minutes <= 1440, '计划总时长最多1440分钟');
const goalsBody = z.object({ effective_date: date, expected_version: z.number().int().nonnegative(), targets,
  plan: plan.nullable().default(null), source: z.string().trim().min(1).max(100).default('user_provided') });
const observation = z.string().trim().min(1).max(200).nullable().default(null);
const checkInBody = z.object({ expected_version: z.number().int().nonnegative(),
  values: z.object({ appetite: observation, energy: observation, movement: observation, stool: observation }),
  observed_at: dateTime.optional(), notes: z.string().max(4000).default(''), toileting_record_id: z.uuid().nullable().default(null) });
const intervalQuery = pageQuery.extend({ from: dateTime.optional(), to: dateTime.optional(),
  bucket: z.enum(['hour', 'day']).default('hour'), timezone: z.string().optional() });
const trendQuery = pageQuery.extend({ metric: z.enum(['steps', 'active_minutes', 'sleep_minutes', 'distance_m', 'weight_kg']),
  from: date, to: date, timezone: z.string().optional() });
const shift = (value: string, days: number) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const presentGoal = ({ targets_json, plan_json, ...row }: Row): Row => ({ ...row, targets: JSON.parse(targets_json), plan: plan_json ? JSON.parse(plan_json) : null });
export async function effectiveGoals(db: Db, petId: string, localDate: string): Promise<Row | null> {
  const row = await db.get('SELECT * FROM pet_goals WHERE pet_id=? AND effective_date<=? ORDER BY effective_date DESC,version DESC LIMIT 1', petId, localDate);
  return row ? presentGoal(row) : null;
}
function afterCursor(raw: string | undefined, scope: Row): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (JSON.stringify(parsed.scope) !== JSON.stringify(scope) || typeof parsed.after !== 'string') throw new Error();
    return parsed.after;
  } catch { return fail(400, 'INVALID_CURSOR', '游标不属于本次用户、宠物或查询范围'); }
}
const nextCursor = (scope: Row, after: string) => Buffer.from(JSON.stringify({ scope, after })).toString('base64url');

export class WellnessService {
  constructor(@Inject(Db) readonly db: Db) {}
  async goals(user: string, petId: string, raw: unknown): Promise<Row> {
    await this.db.pet(user, petId);
    const input = period.parse(raw), timezone = await timezoneForPet(this.db, petId, input.timezone);
    const window = activityWindow(input.date, timezone, this.db.clock()), goals = await effectiveGoals(this.db, petId, window.date);
    const activity = await new CareService(this.db).daily(user, petId, { date: window.date, timezone });
    return { pet_id: petId, local_date: window.date, timezone, effective_date_version: goals?.effective_date === window.date ? goals.version : 0, goals, progress: Object.fromEntries(['steps', 'active_minutes'].map(metric => {
      const target = goals?.targets[metric] ?? null, actual = activity[metric];
      return [metric, { actual, target, percent: actual === null || target === null ? null : Math.round(actual / target * 10000) / 100 }];
    })), activity_source_revision: activity.source_revision };
  }
  async putGoals(user: string, petId: string, raw: unknown, key?: string): Promise<Row> {
    const input = goalsBody.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, petId, true);
      return this.db.idempotent(user, `PUT /pets/${petId}/goals`, key, input, async () => {
        const version = (await this.db.get('SELECT MAX(version) AS version FROM pet_goals WHERE pet_id=? AND effective_date=?', petId, input.effective_date))?.version ?? 0;
        if (version !== input.expected_version) fail(409, 'VERSION_CONFLICT', '目标版本已改变，请重读后保存');
        const id = this.db.id();
        await this.db.run('INSERT INTO pet_goals(id,pet_id,effective_date,version,targets_json,plan_json,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          id, petId, input.effective_date, version + 1, JSON.stringify(input.targets), input.plan ? JSON.stringify(input.plan) : null, input.source, user, this.db.now());
        await this.db.audit(user, 'pet.goals_saved', id, { pet_id: petId, version: version + 1 });
        return presentGoal((await this.db.get('SELECT * FROM pet_goals WHERE id=?', id))!);
      });
    });
  }
  private async presentCheckIn(row: Row): Promise<Row> {
    const { values_json, ...rest } = row;
    const linked = row.toileting_record_id ? await this.db.get('SELECT withdrawn_at FROM care_records WHERE id=?', row.toileting_record_id) : null;
    return { ...rest, values: JSON.parse(values_json), toileting_record_status: !row.toileting_record_id ? null : linked?.withdrawn_at ? 'withdrawn' : linked ? 'active' : 'deleted' };
  }
  async checkIn(user: string, petId: string, raw: unknown): Promise<Row> {
    await this.db.pet(user, petId);
    const input = period.parse(raw), timezone = await timezoneForPet(this.db, petId, input.timezone);
    const window = activityWindow(input.date, timezone, this.db.clock());
    const row = await this.db.get('SELECT * FROM body_check_ins WHERE pet_id=? AND local_date=? AND timezone=? ORDER BY version DESC LIMIT 1', petId, window.date, timezone);
    return row ? this.presentCheckIn(row) : { pet_id: petId, local_date: window.date, timezone, version: 0, values: { appetite: null, energy: null, movement: null, stool: null }, observed_at: null, notes: '', toileting_record_id: null, toileting_record_status: null };
  }
  async putCheckIn(user: string, petId: string, rawQuery: unknown, rawBody: unknown, key?: string): Promise<Row> {
    const query = period.parse(rawQuery), input = checkInBody.parse(rawBody);
    return this.db.transaction(async () => {
      await this.db.pet(user, petId, true);
      const timezone = await timezoneForPet(this.db, petId, query.timezone), window = activityWindow(query.date, timezone, this.db.clock());
      return this.db.idempotent(user, `PUT /pets/${petId}/body-check-ins`, key, { ...input, date: window.date, timezone }, async () => {
        const observed = input.observed_at ?? this.db.now();
        if (observed < window.start || observed >= window.end) fail(400, 'OBSERVATION_DATE_MISMATCH', '观察时间必须落在所选当地日期内');
        if (observed > this.db.now()) fail(400, 'FUTURE_OBSERVATION', '观察时间不能晚于当前时间');
        const current = await this.checkIn(user, petId, { date: window.date, timezone });
        if (current.version !== input.expected_version) fail(409, 'VERSION_CONFLICT', '身体观察版本已改变，请重读后保存');
        if (input.toileting_record_id) {
          const record = await this.db.get("SELECT * FROM care_records WHERE id=? AND pet_id=? AND type='toileting' AND withdrawn_at IS NULL", input.toileting_record_id, petId);
          if (!record || !['defecation', 'both'].includes(JSON.parse(record.value_json).kind) || record.recorded_at < window.start || record.recorded_at >= window.end) fail(400, 'INVALID_TOILETING_REFERENCE', '排便引用必须是本宠物当天有效的排便手记');
        }
        const id = this.db.id();
        await this.db.run('INSERT INTO body_check_ins(id,pet_id,local_date,timezone,version,observed_at,values_json,notes,toileting_record_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          id, petId, window.date, timezone, current.version + 1, observed, JSON.stringify(input.values), input.notes, input.toileting_record_id, user, this.db.now());
        await this.db.audit(user, 'pet.body_check_in_saved', id, { pet_id: petId, version: current.version + 1 });
        return this.presentCheckIn((await this.db.get('SELECT * FROM body_check_ins WHERE id=?', id))!);
      });
    });
  }
  async intervals(user: string, petId: string, raw: unknown): Promise<Row> {
    return this.db.transaction(async () => {
      await this.db.pet(user, petId);
      const input = intervalQuery.parse(raw), timezone = await timezoneForPet(this.db, petId, input.timezone);
      const range = boundedRange(input.from, input.to, this.db.clock());
      const scope = { user, petId, ...range, bucket: input.bucket, timezone }, after = afterCursor(input.cursor, scope);
      if (after && (after < range.from || after >= range.to || !Number.isFinite(Date.parse(after)))) fail(400, 'INVALID_CURSOR', '分桶游标超出查询范围');
      const care = new CareService(this.db), items: Row[] = [];
      let start = after ?? range.from;
      while (start < range.to && items.length < input.limit) {
        const day = activityWindow(undefined, timezone, new Date(start));
        const end = new Date(Math.min(Date.parse(range.to), input.bucket === 'hour' ? Date.parse(start) + 3600000 : Date.parse(day.end))).toISOString();
        items.push(await care.interval(user, petId, { ...day, start, end })); start = end;
      }
      return { pet_id: petId, timezone, ...range, bucket: input.bucket, items, next_cursor: start < range.to ? nextCursor(scope, start) : null };
      });
  }
  async trends(user: string, petId: string, raw: unknown): Promise<Row> {
    return this.db.transaction(async () => {
      await this.db.pet(user, petId);
      const input = trendQuery.parse(raw), timezone = await timezoneForPet(this.db, petId, input.timezone);
      const count = (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86400000;
      if (count <= 0 || count > 31) fail(400, 'INVALID_RANGE', '趋势使用含from、不含to的当地日期，单次最多31天');
      const scope = { user, petId, from: input.from, to: input.to, metric: input.metric, timezone }, after = afterCursor(input.cursor, scope);
      if (after && (after < input.from || after >= input.to || !date.safeParse(after).success)) fail(400, 'INVALID_CURSOR', '趋势游标超出查询范围');
      const care = new CareService(this.db), items: Row[] = [];
      const point = async (localDate: string): Promise<Row> => {
        const window = activityWindow(localDate, timezone, this.db.clock());
        if (input.metric === 'weight_kg') {
          const rows = await this.db.all("SELECT id,recorded_at,value_json,source FROM care_records WHERE pet_id=? AND type='weight' AND withdrawn_at IS NULL AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at DESC,created_at DESC,id DESC", petId, window.start, window.end);
          return { local_date: localDate, period_start: window.start, period_end: window.end, value: rows.length ? JSON.parse(rows[0].value_json).weight_kg : null,
            sample_count: rows.length, coverage_seconds: null, data_status: rows.length ? 'recorded' : 'missing', estimated: false,
            sources: [...new Set(rows.map(row => row.source))], records: rows.map(({ value_json, ...row }) => ({ ...row, value: JSON.parse(value_json) })) };
        }
        const summary = await care.interval(user, petId, window), column = { steps: 'steps', active_minutes: 'active_seconds', sleep_minutes: 'sleep_seconds', distance_m: 'distance_m' }[input.metric];
        const samples = summary.metric_sample_counts[column], coverage = summary.metric_coverage_seconds[column];
        const sources = await this.db.all(`SELECT DISTINCT source FROM activity_samples WHERE pet_id=? AND start_at<? AND end_at>? AND ${column} IS NOT NULL ORDER BY source`, petId, window.end, window.start);
        return { local_date: localDate, period_start: window.start, period_end: window.end, value: summary[input.metric], sample_count: summary.metric_sample_counts[column],
          coverage_seconds: coverage, data_status: !samples ? 'missing' : coverage * 1000 < Date.parse(window.end) - Date.parse(window.start) ? 'partial' : 'available', estimated: summary.estimated,
          sources: sources.map(row => row.source), source_revision: summary.source_revision, aggregation_version: summary.aggregation_version };
      };
      let current = after ?? input.from;
      while (current < input.to && items.length < input.limit) {
        const value = await point(current), previous = await point(shift(current, -count));
        const duration = Date.parse(value.period_end) - Date.parse(value.period_start), previousDuration = Date.parse(previous.period_end) - Date.parse(previous.period_start);
        let reason: string | null = value.value === null ? 'current_missing' : previous.value === null ? 'baseline_missing' : previous.value === 0 ? 'baseline_zero' : null;
        if (!reason && input.metric !== 'weight_kg') {
          if (value.period_end > this.db.now() || previous.period_end > this.db.now()) reason = 'incomplete_day';
          else if (duration !== previousDuration) reason = 'unequal_day_duration';
          else if (value.coverage_seconds * 1000 / duration < 0.5 || previous.coverage_seconds * 1000 / previousDuration < 0.5) reason = 'insufficient_coverage';
          else if (JSON.stringify([...value.sources].sort()) !== JSON.stringify([...previous.sources].sort())) reason = 'different_sources';
        }
        const goals = await effectiveGoals(this.db, petId, current);
        items.push({ ...value, target: goals?.targets[input.metric] ?? null, goal_id: goals?.id ?? null,
          comparison: { rule_version: 'equal-calendar-window-v1', baseline: previous, comparable: reason === null, reason,
            percent_change: reason ? null : Math.round((value.value - previous.value) / previous.value * 10000) / 100 } });
        current = shift(current, 1);
      }
      return { pet_id: petId, metric: input.metric, unit: input.metric === 'weight_kg' ? 'kg' : input.metric.endsWith('minutes') ? 'minutes' : input.metric === 'distance_m' ? 'm' : 'steps',
        timezone, from: input.from, to: input.to, bucket: 'day', comparison_from: shift(input.from, -count), comparison_to: input.from,
        items, next_cursor: current < input.to ? nextCursor(scope, current) : null };
      });
  }
}

@ApiTags('本地照护目标与趋势') @ApiBearerAuth() @Controller('pets/:id')
export class WellnessController {
  constructor(private readonly wellness: WellnessService) {}
  @Get('goals') @ApiQuery({ name: 'date', required: false }) @ApiQuery({ name: 'timezone', required: false })
  goals(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.wellness.goals(user, id, query); }
  @Put('goals') @JsonBody(goalsBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  putGoals(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.wellness.putGoals(user, id, body, key); }
  @Get('body-check-ins') @ApiQuery({ name: 'date', required: false }) @ApiQuery({ name: 'timezone', required: false })
  checkIn(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.wellness.checkIn(user, id, query); }
  @Put('body-check-ins') @JsonBody(checkInBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  putCheckIn(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.wellness.putCheckIn(user, id, query, body, key); }
  @Get('activity/intervals') @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false }) @ApiQuery({ name: 'bucket', enum: ['hour', 'day'], required: false })
  @ApiQuery({ name: 'timezone', required: false }) @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false, type: Number })
  intervals(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.wellness.intervals(user, id, query); }
  @Get('trends') @ApiQuery({ name: 'metric', enum: ['steps', 'active_minutes', 'sleep_minutes', 'distance_m', 'weight_kg'] })
  @ApiQuery({ name: 'from' }) @ApiQuery({ name: 'to' }) @ApiQuery({ name: 'timezone', required: false }) @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false, type: Number })
  trends(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.wellness.trends(user, id, query); }
}
