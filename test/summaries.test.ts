import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Db, Row } from '../src/db';
import { activityWindow, CareService } from '../src/care';
import { ObservationsService } from '../src/observations';

async function fixture(path = ':memory:') {
  let now = new Date('2026-11-18T12:00:00Z'), seq = 0;
  const db = new Db(path, () => now);
  for (const id of ['owner', 'viewer', 'stranger']) await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', id, `${id}@example.invalid`, 'unused', db.now());
  await db.run('INSERT INTO households VALUES (?,?,?,?)', 'home', 'Home', 'owner', db.now());
  for (const role of ['owner', 'viewer']) await db.run('INSERT INTO household_members VALUES (?,?,?,?)', 'home', role, role, db.now());
  await db.run('INSERT INTO household_settings VALUES (?,?)', 'home', 'UTC');
  await db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)', 'pet', 'home', 'Doogy', 'dog', null, null, null, db.now(), db.now());
  await db.run('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', 'device', 'summaries-fixture', 'fixture', 'fixture', 'unused', db.now());
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
  const day = async (date: string, metrics: Row = {}, timezone = 'UTC') => {
    const window = activityWindow(date, timezone, now);
    return await span(window.start, window.end, metrics);
  };
  return { db, care, observations, day, span, clock: (value: string) => { now = new Date(value); } };
}

test('日汇总持久缓存复用，迟到插入/修改/删除均按来源版本回算', async () => {
  const path = join(tmpdir(), `doogy-summary-${randomUUID()}.db`), f = await fixture(path);
  let reopened: Db | undefined;
  try {
    const firstId = await f.span('2026-11-17T00:00:00Z', '2026-11-17T12:00:00Z', { steps: 100, active_seconds: 600 });
    const first = await f.care.daily('owner', 'pet', { date: '2026-11-17' });
    assert.equal(first.aggregation_version, 'daily-v2');
    assert.equal(first.source_revision, 1);
    f.clock('2026-11-18T13:00:00Z');
    assert.deepEqual((await f.care.daily('viewer', 'pet', { date: '2026-11-17' })), first);
    await f.db.run('UPDATE activity_samples SET steps=? WHERE id=?', 150, firstId);
    const changed = await f.care.daily('owner', 'pet', { date: '2026-11-17' });
    assert.equal(changed.steps, 150);
    assert.equal(changed.source_revision, 2);
    const lateId = await f.span('2026-11-17T12:00:00Z', '2026-11-18T00:00:00Z', { steps: 50 });
    assert.equal((await f.care.daily('owner', 'pet', { date: '2026-11-17' })).steps, 200);
    await f.db.run('DELETE FROM activity_samples WHERE id=?', lateId);
    const final = await f.care.daily('owner', 'pet', { date: '2026-11-17' });
    assert.equal(final.steps, 150);
    assert.equal(final.source_revision, 4);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM daily_summaries'))!.n, 1);
    await f.db.close();
    reopened = new Db(path, () => new Date('2026-11-20T00:00:00Z'));
    assert.deepEqual((await new CareService(reopened).daily('owner', 'pet', { date: '2026-11-17' })), final);
  } finally {
    if (reopened) await reopened.close(); else { try { await f.db.close(); } catch { /* closed before reopening */ } }
    for (const suffix of ['', '-wal', '-shm']) try { unlinkSync(path + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
});

test('覆盖率按指标分别合并区间，不把另一个指标的数据当作自己的覆盖', async () => {
  const f = await fixture();
  try {
    await f.span('2026-11-17T00:00:00Z', '2026-11-17T12:00:00Z', { steps: 100 });
    await f.span('2026-11-17T12:00:00Z', '2026-11-18T00:00:00Z', { active_seconds: 600 });
    const summary = await f.care.daily('owner', 'pet', { date: '2026-11-17' });
    assert.equal(summary.coverage_seconds, 86400);
    assert.equal(summary.metric_coverage_seconds.steps, 43200);
    assert.equal(summary.metric_coverage_seconds.active_seconds, 43200);
    assert.equal(summary.metric_coverage_seconds.sleep_seconds, 0);
    assert.equal(summary.sleep_minutes, null);
    assert.equal(summary.data_status, 'available');
  } finally { await f.db.close(); }
});

test('日汇总缓存按时区独立，夏令时23/25小时覆盖保持正确', async () => {
  const f = await fixture();
  try {
    const spring = activityWindow('2026-03-08', 'America/New_York', new Date());
    await f.span(spring.start, spring.end, { steps: 230 });
    const ny = await f.care.daily('owner', 'pet', { date: '2026-03-08', timezone: 'America/New_York' });
    assert.equal(ny.metric_coverage_seconds.steps, 23 * 3600);
    assert.equal(ny.steps, 230);
    await f.care.daily('owner', 'pet', { date: '2026-03-08', timezone: 'UTC' });
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM daily_summaries WHERE local_date=?', '2026-03-08'))!.n, 2);
    const fall = activityWindow('2026-11-01', 'America/New_York', new Date());
    const middle = new Date(Date.parse(fall.start) + 12 * 3600_000).toISOString();
    await f.span(fall.start, middle, { steps: 120 });
    await f.span(middle, fall.end, { steps: 130 });
    const fallSummary = await f.care.daily('owner', 'pet', { date: '2026-11-01', timezone: 'America/New_York' });
    assert.equal(fallSummary.metric_coverage_seconds.steps, 25 * 3600);
    assert.equal(fallSummary.steps, 250);
  } finally { await f.db.close(); }
});

test('观察先要求三个有效历史日，证据记录中位数与来源版本，变更后保留旧快照', async () => {
  const f = await fixture();
  try {
    for (const date of ['2026-11-11', '2026-11-13']) await f.day(date, { steps: 1000, active_seconds: 1200 });
    await f.day('2026-11-17', { steps: 600, active_seconds: 900 });
    const pending = await f.observations.get('owner', 'pet', {});
    assert.equal(pending.local_date, '2026-11-17');
    assert.equal(pending.status, 'insufficient_data');
    assert.equal(pending.comparisons[0].reason, 'insufficient_baseline');
    await f.day('2026-11-16', { steps: 1000, active_seconds: 1200 });
    const ready = await f.observations.get('owner', 'pet', {});
    assert.equal(ready.status, 'ready');
    assert.equal(ready.comparisons[0].baseline_days, 3);
    assert.equal(ready.comparisons[0].baseline_median, 1000);
    assert.equal(ready.comparisons[0].delta_percent, -40);
    assert.equal(ready.comparisons[1].delta_percent, -25);
    assert.equal(ready.observations.length, 1);
    assert.equal(ready.evidence.length, 2);
    assert.equal(ready.evidence[0].baseline.length, 3);
    assert.ok(ready.evidence[0].target.source_revision > 0);
    assert.equal(ready.model_output, null);
    assert.ok(!/疾病|情绪|诊断|用药/.test(ready.observations[0].text));
    assert.deepEqual((await f.observations.get('viewer', 'pet', {})), ready);
    assert.notEqual(ready.id, pending.id);
    assert.deepEqual(JSON.parse((await f.db.get('SELECT result_json FROM activity_observations WHERE id=?', pending.id))!.result_json), pending);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM activity_observations'))!.n, 2);
  } finally { await f.db.close(); }
});

test('目标指标覆盖不足或缺失时不推断，明确上报的零值可参与数值比较', async () => {
  const f = await fixture();
  try {
    for (const date of ['2026-11-11', '2026-11-13', '2026-11-16']) await f.day(date, { steps: 1000, active_seconds: 1200 });
    const short = await f.span('2026-11-17T00:00:00Z', '2026-11-17T01:00:00Z', { steps: 100 });
    const rest = await f.span('2026-11-17T01:00:00Z', '2026-11-18T00:00:00Z', { active_seconds: 0 });
    const partial = await f.observations.get('owner', 'pet', {});
    assert.equal(partial.comparisons[0].reason, 'insufficient_coverage');
    assert.equal(partial.comparisons[0].observed, 100);
    assert.equal(partial.comparisons[1].observed, 0);
    assert.equal(partial.comparisons[1].delta_percent, -100);
    await f.db.run('DELETE FROM activity_samples WHERE id IN (?,?)', short, rest);
    await f.day('2026-11-17', { distance_m: 1200 });
    const missing = await f.observations.get('owner', 'pet', {});
    assert.equal(missing.status, 'insufficient_data');
    assert.ok(missing.comparisons.every((item: Row) => item.reason === 'missing_metric' && item.observed === null));
    assert.deepEqual(missing.observations, []);
  } finally { await f.db.close(); }
});

test('零基线不计算无限百分比，未结束自然日不生成观察', async () => {
  const f = await fixture();
  try {
    for (const date of ['2026-11-11', '2026-11-13', '2026-11-16']) await f.day(date, { steps: 0, active_seconds: 0 });
    await f.day('2026-11-17', { steps: 100, active_seconds: 60 });
    const zero = await f.observations.get('owner', 'pet', {});
    assert.equal(zero.status, 'ready');
    assert.ok(zero.comparisons.every((item: Row) => item.reason === 'baseline_zero' && item.delta_percent === null));
    assert.deepEqual(zero.observations, []);
    const today = await f.observations.get('owner', 'pet', { date: '2026-11-18' });
    assert.equal(today.status, 'day_in_progress');
    assert.deepEqual(today.observations, []);
    assert.ok(today.comparisons.every((item: Row) => item.reason === 'period_not_completed'));
    assert.equal((await f.observations.get('owner', 'pet', { date: '2026-11-19' })).status, 'day_in_progress');
  } finally { await f.db.close(); }
});

test('汇总和观察缓存不能绕过当前权限，撤销共享后立即失去读取能力', async () => {
  const f = await fixture();
  try {
    await f.day('2026-11-17', { steps: 100 });
    await f.observations.get('owner', 'pet', {});
    assert.ok((await f.observations.get('viewer', 'pet', {})).id);
    await f.db.run('DELETE FROM household_members WHERE user_id=?', 'viewer');
    await assert.rejects(async () => await f.observations.get('viewer', 'pet', {}));
    await assert.rejects(async () => await f.care.daily('viewer', 'pet', {}));
    await assert.rejects(async () => await f.observations.get('stranger', 'pet', {}));
    await assert.rejects(async () => await f.observations.get('owner', 'pet', { date: '2026-02-30' }));
    await assert.rejects(async () => await f.observations.get('owner', 'pet', { timezone: 'Not/AZone' }));
  } finally { await f.db.close(); }
});
