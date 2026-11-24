import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { CareService } from '../src/care';
import { Db } from '../src/db';
import { AccountExportService } from '../src/account-export';

beforeEach(() => { process.env.DATA_MODE = 'offline'; process.env.IDEMPOTENCY_TTL_HOURS = '24'; });

async function fixture() {
  let now = Date.parse('2026-11-17T06:00:00Z');
  const db = new Db(':memory:', () => new Date(now)), home = db.id();
  await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', 'owner', 'care-types@example.invalid', 'unused', db.now());
  await db.run('INSERT INTO households VALUES (?,?,?,?)', home, 'Care types', 'owner', db.now());
  await db.run('INSERT INTO household_members VALUES (?,?,?,?)', home, 'owner', 'owner', db.now());
  await db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)', 'pet', home, 'Care pet', 'dog', null, null, 9, db.now(), db.now());
  return { db, home, service: new CareService(db), advance: () => { now += 1000; } };
}
const input = (type: string, value: Record<string, any>, extra: Record<string, any> = {}) => ({
  pet_id: 'pet', type, value, recorded_at: '2026-11-17T03:00:00Z', ...extra,
});

test('排泄三类事实保留JSON字段，编辑替换整个value并继续校验kind', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  for (const kind of ['urination', 'defecation', 'both']) {
    const value = { kind, location: '户外', details: { normal: true }, tags: ['早晨'], amount: null };
    const record = await f.service.create('owner', input('toileting', value));
    assert.equal(record.type, 'toileting'); assert.equal(record.custom_type, null);
    assert.equal(record.source, 'owner'); assert.equal(record.notes, '');
    assert.deepEqual((await f.service.get('owner', record.id)).value, value);
    const replacement = { kind: 'both', notes: '散步后' };
    assert.deepEqual((await f.service.update('owner', record.id, { value: replacement })).value, replacement);
    await assert.rejects(f.service.update('owner', record.id, { value: { notes: '缺少排泄类型' } }));
    await assert.rejects(f.service.update('owner', record.id, { value: { kind: 'unknown' } }));
    assert.deepEqual((await f.service.history('owner', record.id)).revisions[0].record.value, value);
  }
  assert.equal((await f.service.list('owner', 'pet', { type: 'toileting' })).items.length, 3);
});

test('自定义照护名称裁剪、保留和改名，值可为空对象且类型不可变', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const original = await f.service.create('owner', input('custom', { duration: 5, tools: ['牙刷'] }, { custom_type: '  刷牙  ' }));
  assert.equal(original.custom_type, '刷牙');
  f.advance();
  const notesOnly = await f.service.update('owner', original.id, { notes: '愿意配合' });
  assert.equal(notesOnly.custom_type, '刷牙'); assert.deepEqual(notesOnly.value, original.value);
  f.advance();
  const renamed = await f.service.update('owner', original.id, { custom_type: '  口腔护理  ', value: {}, type: 'weight' });
  assert.equal(renamed.custom_type, '口腔护理'); assert.equal(renamed.type, 'custom');
  assert.deepEqual(renamed.value, {}); assert.equal(renamed.notes, '愿意配合');
  const history = await f.service.history('owner', original.id);
  assert.deepEqual(history.current, renamed); assert.equal(history.revisions.length, 2);
  assert.equal(history.revisions[0].record.custom_type, '刷牙');
  assert.equal(history.revisions[1].record.custom_type, '刷牙');
  assert.equal(history.revisions[1].record.notes, '愿意配合');
});

test('自定义名称只适用于custom且不能为空或超长，排泄必须携带合法kind', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  for (const custom_type of [undefined, null, '', '   ', 'x'.repeat(101), 42]) {
    await assert.rejects(f.service.create('owner', input('custom', {}, { custom_type })));
  }
  for (const type of ['weight', 'feeding', 'medication', 'grooming', 'note', 'toileting']) {
    const value = type === 'weight' ? { weight_kg: 11 } : type === 'toileting' ? { kind: 'urination' } : {};
    await assert.rejects(f.service.create('owner', input(type, value, { custom_type: '不适用名称' })));
    const record = await f.service.create('owner', input(type, value));
    await assert.rejects(f.service.update('owner', record.id, { custom_type: '不能改名' }));
    assert.equal((await f.service.get('owner', record.id)).custom_type, null);
  }
  for (const value of [{}, { kind: null }, { kind: 'other' }, { kind: ['urination'] }]) {
    await assert.rejects(f.service.create('owner', input('toileting', value)));
  }
  const longest = await f.service.create('owner', input('custom', {}, { custom_type: `  ${'x'.repeat(100)}  ` }));
  assert.equal(longest.custom_type.length, 100);
  for (const custom_type of [null, '', '   ', 'x'.repeat(101)]) await assert.rejects(f.service.update('owner', longest.id, { custom_type }));
  assert.equal((await f.service.get('owner', longest.id)).custom_type, longest.custom_type);
  assert.equal((await f.service.history('owner', longest.id)).revisions.length, 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM care_records'))!.n, 7);
});

test('自定义名称精确过滤与类型、状态、时间窗口和分页共同生效', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const matching = [];
  for (const day of [15, 16, 17]) matching.push(await f.service.create('owner', input('custom', { day }, { custom_type: '刷牙', recorded_at: `2026-11-${day}T03:00:00Z` })));
  await f.service.create('owner', input('custom', {}, { custom_type: '刷牙加餐' }));
  await f.service.create('owner', input('toileting', { kind: 'defecation' }));
  const filter = { type: 'custom', custom_type: '  刷牙  ', from: '2026-11-16T00:00:00Z', to: '2026-11-18T00:00:00Z', limit: 1 };
  const first = await f.service.list('owner', 'pet', filter);
  assert.deepEqual(first.items.map(row => row.id), [matching[2].id]); assert.equal(first.next_cursor, matching[2].id);
  await f.service.withdraw('owner', matching[2].id, { reason: '重复补录' });
  const second = await f.service.list('owner', 'pet', { ...filter, cursor: first.next_cursor });
  assert.deepEqual(second.items.map(row => row.id), [matching[1].id]); assert.equal(second.next_cursor, null);
  assert.equal((await f.service.list('owner', 'pet', { custom_type: '刷牙', status: 'all' })).items.length, 3);
  assert.deepEqual((await f.service.list('owner', 'pet', { ...filter, status: 'withdrawn' })).items.map(row => row.id), [matching[2].id]);
  assert.deepEqual((await f.service.list('owner', 'pet', { type: 'toileting', custom_type: '刷牙' })).items, []);
  assert.deepEqual((await f.service.list('owner', 'pet', { custom_type: '刷' })).items, []);
  for (const custom_type of ['', '   ', 'x'.repeat(101)]) await assert.rejects(f.service.list('owner', 'pet', { custom_type }));
});

test('原五种照护保持默认值，新增类型不改体重，概览和导出保留名称及撤回历史', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const oldTypes = [
    ['weight', { weight_kg: 12 }], ['feeding', { food: '主粮', grams: 100 }],
    ['medication', { name: '已遵医嘱记录', dose: '一次' }], ['grooming', { task: '洗澡' }], ['note', { text: '状态良好' }],
  ] as const;
  for (const [type, value] of oldTypes) {
    const record = await f.service.create('owner', input(type, value));
    assert.equal(record.type, type); assert.equal(record.custom_type, null);
    assert.equal(record.source, 'owner'); assert.equal(record.notes, ''); assert.deepEqual(record.value, value);
  }
  const toileting = await f.service.create('owner', input('toileting', { kind: 'urination', weight_kg: 99 }));
  const custom = await f.service.create('owner', input('custom', { weight_kg: 88 }, { custom_type: '散步' }));
  await f.service.update('owner', toileting.id, { value: { kind: 'both', weight_kg: 77 } });
  await f.service.update('owner', custom.id, { custom_type: '户外散步', value: { weight_kg: 66 } });
  assert.equal((await f.db.get('SELECT weight_kg FROM pets WHERE id=?', 'pet'))!.weight_kg, 12);
  const overview = await f.service.overview('owner', 'pet', { date: '2026-11-17' });
  assert.equal(overview.care_records.length, 7);
  const overviewCustom = overview.care_records.find((row: any) => row.id === custom.id);
  assert.ok(overviewCustom); assert.equal(overviewCustom.custom_type, '户外散步');
  const withdrawn = await f.service.withdraw('owner', custom.id, { reason: '重复行' });
  await f.service.withdraw('owner', toileting.id, { reason: '重复排泄记录' });
  assert.equal(withdrawn.custom_type, '户外散步');
  assert.equal((await f.db.get('SELECT weight_kg FROM pets WHERE id=?', 'pet'))!.weight_kg, 12);
  assert.equal((await f.service.overview('owner', 'pet', { date: '2026-11-17' })).care_records.length, 5);
  const exporter = new AccountExportService(f.db);
  const rows = (await exporter.page('owner', 'care_records', { household_id: f.home })).items;
  const exported = rows.find((row: any) => row.id === custom.id);
  assert.equal(rows.length, 7); assert.equal(exported.custom_type, '户外散步');
  assert.equal(exported.withdrawn_at, withdrawn.withdrawn_at); assert.deepEqual(exported.value, { weight_kg: 66 });
  assert.equal(rows.find((row: any) => row.id === toileting.id).custom_type, null);
  const revisions = (await exporter.page('owner', 'care_record_revisions', { household_id: f.home })).items.filter((row: any) => row.record_id === custom.id);
  assert.deepEqual(revisions.map((row: any) => row.record.custom_type).sort(), ['户外散步', '散步'].sort());
});

test('旧创建编辑键保持原请求形状，自定义名称裁剪后同键重放且不同内容冲突', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const oldInput = input('note', { text: '旧客户端请求' });
  const legacy = await f.service.create('owner', oldInput, 'legacy-create');
  const legacyKey = await f.db.get('SELECT request_json FROM idempotency_keys WHERE key=?', 'legacy-create');
  assert.deepEqual(JSON.parse(legacyKey!.request_json), { ...oldInput, recorded_at: '2026-11-17T03:00:00.000Z', source: 'owner', notes: '' });
  assert.deepEqual(await f.service.create('owner', oldInput, 'legacy-create'), legacy);
  const oldPatch = { notes: '旧客户端编辑' }, edited = await f.service.update('owner', legacy.id, oldPatch, 'legacy-edit');
  assert.deepEqual(JSON.parse((await f.db.get('SELECT request_json FROM idempotency_keys WHERE key=?', 'legacy-edit'))!.request_json), oldPatch);
  assert.deepEqual(await f.service.update('owner', legacy.id, oldPatch, 'legacy-edit'), edited);
  const custom = await f.service.create('owner', input('custom', {}, { custom_type: '  刷牙  ' }), 'custom-create');
  assert.deepEqual(await f.service.create('owner', input('custom', {}, { custom_type: '刷牙' }), 'custom-create'), custom);
  f.advance();
  const renamed = await f.service.update('owner', custom.id, { custom_type: '  口腔护理  ' }, 'custom-edit');
  assert.deepEqual(await f.service.update('owner', custom.id, { custom_type: '口腔护理' }, 'custom-edit'), renamed);
  await assert.rejects(f.service.create('owner', input('custom', {}, { custom_type: '散步' }), 'custom-create'));
  await assert.rejects(f.service.update('owner', custom.id, { custom_type: '散步' }, 'custom-edit'));
  assert.equal((await f.service.history('owner', custom.id)).revisions.length, 1);
});
