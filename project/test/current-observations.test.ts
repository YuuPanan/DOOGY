import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Db, Row } from '../src/db';
import { activityWindow, CareService } from '../src/care';
import { ObservationsService } from '../src/observations';

async function fixture(instant = '2026-11-18T12:00:00Z') {
  let now = new Date(instant), seq = 0;
  const db = new Db(':memory:', () => now);
  await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', 'owner', 'owner@example.invalid', 'unused', db.now());
  await db.run('INSERT INTO households VALUES (?,?,?,?)', 'home', 'Home', 'owner', db.now());
  await db.run('INSERT INTO household_members VALUES (?,?,?,?)', 'home', 'owner', 'owner', db.now());
  await db.run('INSERT INTO household_settings VALUES (?,?)', 'home', 'UTC');
  await db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)', 'pet', 'home', 'Doogy', 'dog', null, null, null, db.now(), db.now());
  await db.run('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', 'device', 'current-fixture', 'fixture', 'fixture', 'unused', db.now());
  const care = new CareService(db), observations = new ObservationsService(db, care);
  const span = async (start: string, end: string, metrics: Row = {}) => {
    const id = `sample-${++seq}`;
    await db.run(`INSERT INTO device_events(event_id,device_id,pet_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, 'device', 'pet', 'activity.reported', end, db.now(), seq, 'fixture', '{}', '{}', db.now());
    await db.run('INSERT INTO activity_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, id, 'device', 'pet', start, end,
      metrics.steps ?? null, metrics.active_seconds ?? null, metrics.distance_m ?? null, metrics.sleep_seconds ?? null,
      metrics.estimated ?? 0, 'fixture-device', '{}');
    return id;
  };
  const morning = (date: string, metrics: Row) => span(`${date}T00:00:00.000Z`, `${date}T12:00:00.000Z`, metrics);
  return { db, care, observations, span, morning, clock: (value: string) => { now = new Date(value); } };
}

test('今日观察按相同已过时长比较，跨截止点按比例分配并排除后续区间', async () => {
  const f = await fixture();
  try {
    for (const date of ['2026-11-11', '2026-11-13', '2026-11-16']) {
      await f.morning(date, { steps: 1000, active_seconds: 1200 });
      await f.span(`${date}T12:00:00.000Z`, `${date}T23:00:00.000Z`, { steps: 9000, active_seconds: 6000 });
    }
    await f.span('2026-11-18T00:00:00.000Z', '2026-11-18T10:00:00.000Z', { steps: 400, active_seconds: 400 });
    await f.span('2026-11-18T10:00:00.000Z', '2026-11-18T14:00:00.000Z', { steps: 400, active_seconds: 400 });
    await f.span('2026-11-18T14:00:00.000Z', '2026-11-19T00:00:00.000Z', { steps: 10000 });
    const result = await f.observations.current('owner', 'pet', {});
    assert.equal(result.rule_version, 'activity-current-v1');
    assert.equal(result.comparison_basis, 'equal_elapsed_since_local_midnight');
    assert.equal(result.as_of, '2026-11-18T12:00:00.000Z');
    assert.equal(result.generated_at, result.as_of);
    assert.equal(result.elapsed_seconds, 43200);
    assert.equal(result.status, 'ready');
    assert.equal(result.target.period_end, result.as_of);
    assert.equal(result.target.aggregation_version, 'interval-v1');
    assert.equal(result.target.steps, 600);
    assert.equal(result.target.active_minutes, 10);
    assert.equal(result.target.sample_count, 2);
    assert.equal(result.target.estimated, true);
    assert.equal(result.comparisons[0].baseline_days, 3);
    assert.equal(result.comparisons[0].baseline_median, 1000);
    assert.equal(result.comparisons[0].delta_percent, -40);
    assert.equal(result.comparisons[1].delta_percent, -50);
    assert.equal(result.baseline.length, 7);
    assert.deepEqual(result.baseline_window, { from_date: '2026-11-11', to_date: '2026-11-17' });
    assert.ok(result.baseline.every((day: Row) => Date.parse(day.period_end) - Date.parse(day.period_start) === 43200_000));
    assert.equal(result.evidence[0].baseline.length, 3);
    assert.ok(result.evidence[0].target.source_revision > 0);
    assert.equal(result.model_output, null);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM daily_summaries'))!.n, 0);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM activity_observations'))!.n, 0);
  } finally { await f.db.close(); }
});

test('今日覆盖率逐指标计算，明确零活动可比较，历史指标缺口单独影响基线', async () => {
  const f = await fixture();
  try {
    const ids = [];
    for (const date of ['2026-11-11', '2026-11-13', '2026-11-16']) ids.push(await f.morning(date, { steps: 1000, active_seconds: 1200 }));
    await f.span('2026-11-18T00:00:00.000Z', '2026-11-18T01:00:00.000Z', { steps: 100 });
    await f.span('2026-11-18T01:00:00.000Z', '2026-11-18T12:00:00.000Z', { active_seconds: 0 });
    const result = await f.observations.current('owner', 'pet', {});
    assert.equal(result.target.coverage_seconds, 43200);
    assert.equal(result.comparisons[0].observed, 100);
    assert.equal(result.comparisons[0].coverage_fraction, 1 / 12);
    assert.equal(result.comparisons[0].reason, 'insufficient_coverage');
    assert.equal(result.comparisons[1].observed, 0);
    assert.equal(result.comparisons[1].coverage_fraction, 11 / 12);
    assert.equal(result.comparisons[1].status, 'ready');
    assert.equal(result.comparisons[1].delta_percent, -100);
    await f.db.run('UPDATE activity_samples SET active_seconds=NULL WHERE id=?', ids[0]);
    const missingHistory = await f.observations.current('owner', 'pet', {});
    assert.equal(missingHistory.comparisons[0].baseline_days, 3);
    assert.equal(missingHistory.comparisons[1].baseline_days, 2);
    assert.equal(missingHistory.comparisons[1].reason, 'insufficient_baseline');
    assert.deepEqual(missingHistory.observations, []);
  } finally { await f.db.close(); }
});

test('今日零基线保留零数值且无无限百分比，缺失指标保持null', async () => {
  const f = await fixture();
  try {
    for (const date of ['2026-11-11', '2026-11-13', '2026-11-16']) await f.morning(date, { steps: 0, active_seconds: 0 });
    await f.morning('2026-11-18', { steps: 0 });
    const result = await f.observations.current('owner', 'pet', {});
    assert.equal(result.status, 'ready');
    assert.equal(result.comparisons[0].observed, 0);
    assert.equal(result.comparisons[0].baseline_median, 0);
    assert.equal(result.comparisons[0].reason, 'baseline_zero');
    assert.equal(result.comparisons[0].delta_percent, null);
    assert.equal(result.comparisons[1].observed, null);
    assert.equal(result.comparisons[1].coverage_fraction, 0);
    assert.equal(result.comparisons[1].reason, 'missing_metric');
    assert.deepEqual(result.observations, []);
  } finally { await f.db.close(); }
});

test('当地午夜零长度窗口不读取跨午夜样本，家庭时区与显式覆盖各自生效', async () => {
  const f = await fixture('2026-11-17T16:00:00Z');
  try {
    await f.db.run('UPDATE household_settings SET timezone=? WHERE household_id=?', 'Asia/Shanghai', 'home');
    await f.span('2026-11-17T15:00:00.000Z', '2026-11-17T17:00:00.000Z', { steps: 200, active_seconds: 120 });
    const midnight = await f.observations.current('owner', 'pet', {});
    assert.equal(midnight.local_date, '2026-11-18');
    assert.equal(midnight.timezone, 'Asia/Shanghai');
    assert.equal(midnight.status, 'period_not_started');
    assert.equal(midnight.elapsed_seconds, 0);
    assert.equal(midnight.target.period_start, midnight.as_of);
    assert.equal(midnight.target.period_end, midnight.as_of);
    assert.equal(midnight.target.sample_count, 0);
    assert.equal(midnight.target.steps, null);
    assert.equal(midnight.target.coverage_seconds, 0);
    assert.ok(midnight.comparisons.every((item: Row) => item.reason === 'period_not_started' && item.coverage_fraction === 0));
    assert.deepEqual(midnight.observations, []);
    const utc = await f.observations.current('owner', 'pet', { timezone: 'UTC' });
    assert.equal(utc.local_date, '2026-11-17');
    assert.equal(utc.elapsed_seconds, 16 * 3600);
    assert.equal(utc.target.steps, 100);
    assert.equal(utc.target.estimated, true);
    await f.db.run('INSERT INTO pet_settings VALUES (?,?)', 'pet', 'UTC');
    assert.equal((await f.observations.current('owner', 'pet', {})).timezone, 'UTC');
  } finally { await f.db.close(); }
});

test('夏令时按真实已过秒数比较，23小时历史日不足时剔除，25小时日正常裁剪', async () => {
  const cases = [
    { now: '2026-03-10T03:30:00Z', date: '2026-03-09', history: ['2026-03-05', '2026-03-06', '2026-03-07'], special: '2026-03-08', short: true },
    { now: '2026-11-03T04:30:00Z', date: '2026-11-02', history: ['2026-10-30', '2026-10-31'], special: '2026-11-01', short: false },
  ];
  for (const item of cases) {
    const f = await fixture(item.now), timezone = 'America/New_York', elapsed = 23.5 * 3600_000;
    try {
      const target = activityWindow(item.date, timezone, new Date(item.now));
      for (const date of item.history) {
        const day = activityWindow(date, timezone, new Date(item.now));
        await f.span(day.start, new Date(Date.parse(day.start) + elapsed).toISOString(), { steps: 2350 });
      }
      const special = activityWindow(item.special, timezone, new Date(item.now));
      if (item.short) await f.span(special.start, special.end, { steps: 100000 });
      else {
        const middle = new Date(Date.parse(special.start) + 12 * 3600_000).toISOString();
        await f.span(special.start, middle, { steps: 1200 });
        await f.span(middle, special.end, { steps: 1300 });
      }
      await f.span(target.start, item.now, { steps: 1175 });
      const result = await f.observations.current('owner', 'pet', { timezone });
      assert.equal(result.elapsed_seconds, 84600);
      assert.equal(result.comparisons[0].baseline_days, 3);
      assert.equal(result.comparisons[0].baseline_median, 2350);
      assert.equal(result.comparisons[0].delta_percent, -50);
      const historical = result.baseline.find((day: Row) => day.local_date === item.special)!;
      assert.equal(historical.eligible, !item.short);
      assert.equal(historical.exclusion_reason, item.short ? 'shorter_calendar_day' : null);
      assert.equal(historical.period_end, item.short ? special.end : new Date(Date.parse(special.start) + elapsed).toISOString());
      assert.equal(historical.steps, item.short ? 100000 : 2350);
    } finally { await f.db.close(); }
  }
});

test('固定截止点重复读取及迟到插入修改删除实时回算，不污染旧整日汇总与观察缓存', async () => {
  const f = await fixture();
  try {
    for (const date of ['2026-11-11', '2026-11-13', '2026-11-16']) await f.morning(date, { steps: 1000, active_seconds: 1200 });
    const target = await f.span('2026-11-18T00:00:00.000Z', '2026-11-18T06:00:00.000Z', { steps: 600, active_seconds: 600 });
    const fullDay = await f.care.daily('owner', 'pet', { date: '2026-11-18' });
    const completed = await f.observations.get('owner', 'pet', { date: '2026-11-17' });
    assert.equal(completed.rule_version, 'activity-observation-v1');
    const summaries = await f.db.all('SELECT * FROM daily_summaries ORDER BY local_date,timezone');
    const observations = await f.db.all('SELECT * FROM activity_observations ORDER BY id');
    const first = await f.observations.current('owner', 'pet', {}), repeat = await f.observations.current('owner', 'pet', {});
    assert.deepEqual(repeat.target, first.target);
    assert.equal(repeat.as_of, first.as_of);
    await f.db.run('UPDATE activity_samples SET steps=? WHERE id=?', 800, target);
    const changed = await f.observations.current('owner', 'pet', {});
    assert.equal(changed.target.steps, 800);
    assert.ok(changed.target.source_revision > fullDay.source_revision);
    const late = await f.span('2026-11-18T06:00:00.000Z', '2026-11-18T12:00:00.000Z', { steps: 100 });
    assert.equal((await f.observations.current('owner', 'pet', {})).target.steps, 900);
    await f.db.run('DELETE FROM activity_samples WHERE id=?', late);
    assert.equal((await f.observations.current('owner', 'pet', {})).target.steps, 800);
    assert.deepEqual(await f.db.all('SELECT * FROM daily_summaries ORDER BY local_date,timezone'), summaries);
    assert.deepEqual(await f.db.all('SELECT * FROM activity_observations ORDER BY id'), observations);
  } finally { await f.db.close(); }
});
