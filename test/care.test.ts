import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { activityWindow, CareService } from '../src/care';
import { Db } from '../src/db';

async function fixture() {
  const db = new Db(':memory:', () => new Date('2026-11-17T06:00:00Z'));
  await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', 'owner', 'owner@example.com', 'unused', db.now());
  await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', 'viewer', 'viewer@example.com', 'unused', db.now());
  await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', 'stranger', 'stranger@example.com', 'unused', db.now());
  await db.run('INSERT INTO households VALUES (?,?,?,?)', 'home', 'Home', 'owner', db.now());
  await db.run('INSERT INTO household_members VALUES (?,?,?,?)', 'home', 'owner', 'owner', db.now());
  await db.run('INSERT INTO household_members VALUES (?,?,?,?)', 'home', 'viewer', 'viewer', db.now());
  await db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)', 'pet', 'home', 'Doogy', 'dog', null, null, null, db.now(), db.now());
  return { db, service: new CareService(db) };
}

test('照护保留来源及修改历史，旧体重不会覆盖更新体重', async () => {
  const { db, service } = await fixture();
  try {
    const newer = await service.create('owner', { pet_id: 'pet', type: 'weight', value: { weight_kg: 14 }, recorded_at: '2026-11-17T03:00:00Z', source: 'vet' });
    const older = await service.create('owner', { pet_id: 'pet', type: 'weight', value: { weight_kg: 12 }, recorded_at: '2026-11-16T03:00:00Z' });
    assert.equal((await db.get('SELECT weight_kg FROM pets WHERE id=?', 'pet'))!.weight_kg, 14);
    await service.update('owner', older.id, { value: { weight_kg: 13 } });
    assert.equal((await db.get('SELECT weight_kg FROM pets WHERE id=?', 'pet'))!.weight_kg, 14);
    await service.update('owner', newer.id, { value: { weight_kg: 15 } });
    const history = await service.history('owner', newer.id);
    assert.equal(history.current.value.weight_kg, 15);
    assert.equal(history.current.source, 'vet');
    assert.equal(history.current.created_by, 'owner');
    assert.equal(history.revisions[0].record.value.weight_kg, 14);
    assert.equal(history.revisions[0].changed_by, 'owner');
    assert.equal((await db.get('SELECT weight_kg FROM pets WHERE id=?', 'pet'))!.weight_kg, 15);
    await assert.rejects(async () => await service.create('owner', { pet_id: 'pet', type: 'weight', value: { weight_kg: -1 }, recorded_at: db.now() }));
  } finally { await db.close(); }
});

test('照护只读共享、家庭隔离、按采样时间分页', async () => {
  const { db, service } = await fixture();
  try {
    for (const day of [15, 16, 17]) await service.create('owner', { pet_id: 'pet', type: 'note', value: { text: `day ${day}` }, recorded_at: `2026-11-${day}T03:00:00Z` });
    const first = await service.list('viewer', 'pet', { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.items[0].recorded_at, '2026-11-17T03:00:00.000Z');
    const second = await service.list('viewer', 'pet', { limit: 2, cursor: first.next_cursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.next_cursor, null);
    await assert.rejects(async () => await service.update('viewer', first.items[0].id, { notes: 'no' }));
    await assert.rejects(async () => await service.list('stranger', 'pet', {}));
    await assert.rejects(async () => await service.list('owner', 'pet', { cursor: 'missing' }));
  } finally { await db.close(); }
});

test('日期窗口使用当地午夜，夏令时日期可为23或25小时', () => {
  const spring = activityWindow('2026-03-08', 'America/New_York', new Date());
  const fall = activityWindow('2026-11-01', 'America/New_York', new Date());
  assert.equal((Date.parse(spring.end) - Date.parse(spring.start)) / 3600000, 23);
  assert.equal((Date.parse(fall.end) - Date.parse(fall.start)) / 3600000, 25);
  const shanghai = activityWindow('2026-11-17', 'Asia/Shanghai', new Date());
  assert.equal(shanghai.start, '2026-11-16T16:00:00.000Z');
  assert.throws(() => activityWindow('2026-11-17', 'Not/AZone', new Date()));
});

test('活动保留缺失数据，跨日区间按重叠比例分配并标记估算', async () => {
  const { db, service } = await fixture();
  try {
    const empty = await service.daily('owner', 'pet', { date: '2026-11-17' });
    assert.equal(empty.data_status, 'missing');
    assert.equal(empty.active_minutes, null);
    assert.equal(empty.steps, null);
    await db.run('INSERT INTO devices (id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', 'device', 'test-serial', 'mock', 'test', 'unused', db.now());
    await db.run(`INSERT INTO device_events (event_id,device_id,pet_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 'event', 'device', 'pet', 'activity.reported', db.now(), db.now(), 1, 'boot', '{}', '{}', db.now());
    await db.run(`INSERT INTO activity_samples (id,event_id,device_id,pet_id,start_at,end_at,steps,active_seconds,distance_m,sleep_seconds,estimated,source,raw_metrics_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'sample', 'event', 'device', 'pet', '2026-11-16T15:30:00.000Z', '2026-11-16T16:30:00.000Z', 120, 600, null, null, 0, 'device', '{}');
    const daily = await service.daily('viewer', 'pet', { date: '2026-11-17' });
    assert.equal(daily.sample_count, 1);
    assert.equal(daily.steps, 60);
    assert.equal(daily.active_minutes, 5);
    assert.equal(daily.sleep_minutes, null);
    assert.equal(daily.distance_m, null);
    assert.equal(daily.estimated, true);
    assert.equal(daily.coverage_seconds, 1800);
    assert.equal(daily.data_status, 'partial');
    assert.equal((await service.weekly('owner', 'pet', { date: '2026-11-17' })).days.length, 7);
    await assert.rejects(async () => await service.daily('owner', 'pet', { date: '2026-02-30' }));
  } finally { await db.close(); }
});

test('并发照护修改使用事务内最新记录，不覆盖另一请求刚保存的字段', async () => {
  const { db, service } = await fixture();
  try {
    const record = await service.create('owner', { pet_id: 'pet', type: 'weight', value: { weight_kg: 12 }, recorded_at: db.now() });
    await Promise.all([
      service.update('owner', record.id, { value: { weight_kg: 15 } }),
      service.update('owner', record.id, { notes: '同时补充的照护备注' })
    ]);
    const history = await service.history('owner', record.id);
    assert.equal(history.current.value.weight_kg, 15);
    assert.equal(history.current.notes, '同时补充的照护备注');
    assert.equal(history.revisions.length, 2);
  } finally { await db.close(); }
});
