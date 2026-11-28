import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { CareService } from '../src/care';
import { Db, Row } from '../src/db';
import { PrivacyService } from '../src/privacy';
import { tables } from '../scripts/migrate-postgres';

const status = (code: number, errorCode?: string) => (error: unknown) => error instanceof HttpException && error.getStatus() === code
  && (!errorCode || (error.getResponse() as Row).code === errorCode);
beforeEach(() => { process.env.DATA_MODE = 'offline'; process.env.IDEMPOTENCY_TTL_HOURS = '24'; });

async function fixture() {
  let now = Date.parse('2026-11-17T06:00:00Z');
  const db = new Db(':memory:', () => new Date(now));
  const owner = db.id(), author = db.id(), caregiver = db.id(), viewer = db.id(), outsider = db.id(), home = db.id(), pet = db.id();
  for (const id of [owner, author, caregiver, viewer, outsider]) {
    await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', id, `${id}@example.invalid`, 'unused', db.now());
  }
  await db.run('INSERT INTO households VALUES (?,?,?,?)', home, 'Care withdrawal home', owner, db.now());
  for (const [user, role] of [[owner, 'owner'], [author, 'caregiver'], [caregiver, 'caregiver'], [viewer, 'viewer']]) {
    await db.run('INSERT INTO household_members VALUES (?,?,?,?)', home, user, role, db.now());
  }
  await db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)', pet, home, 'Care pet', 'dog', null, null, 9, db.now(), db.now());
  return { db, service: new CareService(db), privacy: new PrivacyService(db), owner, author, caregiver, viewer, outsider, home, pet,
    advance: (ms = 1000) => { now += ms; } };
}
const note = (pet: string, recorded_at: string, text = 'original note') => ({ pet_id: pet, type: 'note', value: { text }, recorded_at });
async function counts(db: Db, id: string) {
  return { revisions: (await db.get('SELECT COUNT(*) AS n FROM care_record_revisions WHERE record_id=?', id))!.n,
    audits: (await db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE resource_id=? AND action='care.withdrawn'", id))!.n,
    receipts: (await db.get("SELECT COUNT(*) AS n FROM privacy_deletions WHERE kind='care_withdrawal' AND resource_id=?", id))!.n };
}

test('照护编辑键保存首次快照；撤回保留原记录和修订且旧创建/编辑键不会复活记录', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const input = note(f.pet, f.db.now()), created = await f.service.create(f.author, input, 'original-create');
  f.advance();
  const firstEdit = await f.service.update(f.caregiver, created.id, { notes: 'first edit' }, 'first-edit');
  const savedKey = await f.db.get('SELECT * FROM idempotency_keys WHERE key=?', 'first-edit');
  f.advance();
  await f.service.update(f.author, created.id, { notes: 'later edit' });
  assert.deepEqual(await f.service.update(f.caregiver, created.id, { notes: 'first edit' }, 'first-edit'), firstEdit);
  assert.equal((await f.service.get(f.viewer, created.id)).notes, 'later edit');
  assert.equal((await f.service.history(f.owner, created.id)).revisions.length, 2);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='care.updated'"))!.n, 2);
  assert.deepEqual(await f.db.get('SELECT * FROM idempotency_keys WHERE key=?', 'first-edit'), savedKey);
  await assert.rejects(f.service.update(f.caregiver, created.id, { notes: 'changed intent' }, 'first-edit'), status(409, 'IDEMPOTENCY_CONFLICT'));
  f.advance();
  const withdrawn = await f.service.withdraw(f.author, created.id, { reason: 'duplicate measurement' }, 'withdraw-once');
  assert.equal(withdrawn.withdrawn_by, f.author); assert.equal(withdrawn.withdrawal_reason, 'duplicate measurement');
  assert.ok(withdrawn.withdrawn_at); assert.equal(withdrawn.updated_at, withdrawn.withdrawn_at);
  const history = await f.service.history(f.viewer, created.id);
  assert.deepEqual(history.current, withdrawn); assert.equal(history.revisions.length, 3);
  assert.equal(history.revisions[2].record.notes, 'later edit'); assert.equal(history.revisions[2].record.withdrawn_at, null);
  assert.equal(history.revisions[2].changed_by, f.author);
  assert.deepEqual(await f.service.get(f.viewer, created.id), withdrawn);
  assert.deepEqual(await f.service.create(f.author, input, 'original-create'), created);
  await assert.rejects(f.service.update(f.caregiver, created.id, { notes: 'first edit' }, 'first-edit'), status(409, 'CARE_RECORD_WITHDRAWN'));
  await assert.rejects(f.service.update(f.author, created.id, { notes: 'new edit' }), status(409, 'CARE_RECORD_WITHDRAWN'));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM care_records WHERE id=?', created.id))!.n, 1);
  assert.deepEqual(await f.service.get(f.owner, created.id), withdrawn);
});

test('撤回有键和无键重试均不产生新修订/审计/日志，日志只携带资源及时间', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const record = await f.service.create(f.author, note(f.pet, f.db.now(), 'private care value'));
  const body = { reason: 'private withdrawal reason' };
  const [first, duplicate] = await Promise.all([
    f.service.withdraw(f.author, record.id, body, 'withdraw-retry'), f.service.withdraw(f.author, record.id, body, 'withdraw-retry')
  ]);
  assert.deepEqual(duplicate, first);
  const key = await f.db.get('SELECT * FROM idempotency_keys WHERE key=?', 'withdraw-retry');
  f.advance();
  assert.deepEqual(await f.service.withdraw(f.author, record.id, body, 'withdraw-retry'), first);
  assert.deepEqual(await f.service.withdraw(f.author, record.id, body), first);
  assert.deepEqual(await f.service.withdraw(f.author, record.id, body), first);
  assert.deepEqual(await counts(f.db, record.id), { revisions: 1, audits: 1, receipts: 1 });
  assert.deepEqual(await f.db.get('SELECT * FROM idempotency_keys WHERE key=?', 'withdraw-retry'), key);
  await assert.rejects(f.service.withdraw(f.author, record.id, { reason: 'different reason' }, 'withdraw-retry'), status(409));
  await assert.rejects(f.service.withdraw(f.author, record.id, { reason: 'different reason' }), status(409));
  const receipts = await f.privacy.receipts();
  assert.deepEqual(Object.keys(receipts[0]).sort(), ['deleted_at', 'id', 'kind', 'resource_id']);
  assert.equal(receipts[0].resource_id, record.id); assert.equal(receipts[0].deleted_at, first.withdrawn_at);
  assert.equal(receipts[0].kind, 'care_withdrawal');
  const audit = await f.db.get("SELECT * FROM audit_logs WHERE action='care.withdrawn' AND resource_id=?", record.id);
  assert.equal(audit!.actor_id, f.author);
  for (const privateValue of ['private care value', body.reason]) {
    assert.ok(!JSON.stringify(receipts).includes(privateValue)); assert.ok(!audit!.metadata_json.includes(privateValue));
  }
});

test('撤回仅限当前可写作者或owner，缓存重放仍检查当前成员角色', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const record = await f.service.create(f.author, note(f.pet, f.db.now()));
  await assert.rejects(f.service.withdraw(f.viewer, record.id, { reason: 'viewer' }), status(403));
  await assert.rejects(f.service.withdraw(f.outsider, record.id, { reason: 'outsider' }), status(404));
  await assert.rejects(f.service.get(f.outsider, record.id), status(404));
  await assert.rejects(f.service.withdraw(f.caregiver, record.id, { reason: 'not author' }), status(403));
  await f.service.update(f.caregiver, record.id, { notes: 'caregiver may edit' });
  const ownerWithdrawal = await f.service.withdraw(f.owner, record.id, { reason: 'owner corrects family data' });
  assert.equal(ownerWithdrawal.withdrawn_by, f.owner);
  const own = await f.service.create(f.author, note(f.pet, f.db.now()));
  const body = { reason: 'author correction' };
  const first = await f.service.withdraw(f.author, own.id, body, 'current-membership');
  await f.db.run("UPDATE household_members SET role='viewer' WHERE household_id=? AND user_id=?", f.home, f.author);
  await assert.rejects(f.service.withdraw(f.author, own.id, body, 'current-membership'), status(403));
  await f.db.run("UPDATE household_members SET role='caregiver' WHERE household_id=? AND user_id=?", f.home, f.author);
  assert.deepEqual(await f.service.withdraw(f.author, own.id, body, 'current-membership'), first);
  await f.db.run('DELETE FROM household_members WHERE household_id=? AND user_id=?', f.home, f.author);
  await assert.rejects(f.service.withdraw(f.author, own.id, body, 'current-membership'), status(404));
  await assert.rejects(f.service.get(f.author, own.id), status(404));
  assert.deepEqual(await counts(f.db, own.id), { revisions: 1, audits: 1, receipts: 1 });
});

test('排队等待事务期间撤权，照护编辑和撤回均按新成员权限执行', async () => {
  for (const operation of ['update', 'withdraw'] as const) for (const change of ['viewer', 'removed'] as const) {
    const f = await fixture();
    try {
      const record = await f.service.create(f.author, note(f.pet, f.db.now()));
      let entered!: () => void, release!: () => void;
      const enteredPromise = new Promise<void>(done => { entered = done; });
      const releasePromise = new Promise<void>(done => { release = done; });
      const blocker = f.db.transaction(async () => {
        entered(); await releasePromise;
        if (change === 'viewer') await f.db.run("UPDATE household_members SET role='viewer' WHERE household_id=? AND user_id=?", f.home, f.author);
        else await f.db.run('DELETE FROM household_members WHERE household_id=? AND user_id=?', f.home, f.author);
      });
      await enteredPromise;
      const pending = operation === 'update' ? f.service.update(f.author, record.id, { notes: 'queued edit' }, 'queued')
        : f.service.withdraw(f.author, record.id, { reason: 'queued withdrawal' }, 'queued');
      const rejected = assert.rejects(pending, status(change === 'viewer' ? 403 : 404));
      release(); await blocker; await rejected;
      assert.deepEqual(await counts(f.db, record.id), { revisions: 0, audits: 0, receipts: 0 });
      assert.equal((await f.db.get('SELECT withdrawn_at FROM care_records WHERE id=?', record.id))!.withdrawn_at, null);
      assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE key=?', 'queued'), undefined);
    } finally { await f.db.close(); }
  }
});

test('撤回失败回滚记录、体重、历史、审计、日志和幂等键，随后同键可重试', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const record = await f.service.create(f.author, { pet_id: f.pet, type: 'weight', value: { weight_kg: 12 }, recorded_at: f.db.now() });
  const original = await f.service.get(f.owner, record.id), audit = f.db.audit.bind(f.db);
  f.db.audit = async (...args: Parameters<Db['audit']>) => { await audit(...args); if (args[1] === 'care.withdrawn') throw new Error('Synthetic withdrawal audit failure'); };
  await assert.rejects(f.service.withdraw(f.author, record.id, { reason: 'retry after rollback' }, 'rollback-key'), /Synthetic withdrawal audit failure/);
  f.db.audit = audit;
  assert.deepEqual(await f.service.get(f.owner, record.id), original);
  assert.equal((await f.db.get('SELECT weight_kg FROM pets WHERE id=?', f.pet))!.weight_kg, 12);
  assert.deepEqual(await counts(f.db, record.id), { revisions: 0, audits: 0, receipts: 0 });
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE key=?', 'rollback-key'), undefined);
  await f.service.withdraw(f.author, record.id, { reason: 'retry after rollback' }, 'rollback-key');
  assert.deepEqual(await counts(f.db, record.id), { revisions: 1, audits: 1, receipts: 1 });
  assert.equal((await f.db.get('SELECT weight_kg FROM pets WHERE id=?', f.pet))!.weight_kg, null);
});

test('体重撤回按采样时间、创建时间和ID选择剩余有效记录，全部撤回后为null', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const createWeight = (weight: number, recorded_at: string) => f.service.create(f.author, { pet_id: f.pet, type: 'weight', value: { weight_kg: weight }, recorded_at });
  const weight = async () => (await f.db.get('SELECT weight_kg FROM pets WHERE id=?', f.pet))!.weight_kg;
  const older = await createWeight(10, '2026-11-16T00:00:00Z'); f.advance();
  const newer = await createWeight(11, '2026-11-17T00:00:00Z'); f.advance();
  const tiedA = await createWeight(12, '2026-11-17T00:00:00Z');
  const tiedB = await createWeight(13, '2026-11-17T00:00:00Z');
  const [last, next] = tiedA.id > tiedB.id ? [tiedA, tiedB] : [tiedB, tiedA];
  assert.equal(await weight(), last.value.weight_kg);
  await f.service.withdraw(f.author, last.id, { reason: 'last tied sample' }); assert.equal(await weight(), next.value.weight_kg);
  await f.service.withdraw(f.author, next.id, { reason: 'remaining tied sample' }); assert.equal(await weight(), 11);
  const other = await f.service.create(f.author, note(f.pet, f.db.now()));
  await f.service.withdraw(f.author, other.id, { reason: 'non-weight correction' }); assert.equal(await weight(), 11);
  await f.service.withdraw(f.author, newer.id, { reason: 'newer sample' }); assert.equal(await weight(), 10);
  await f.service.withdraw(f.author, older.id, { reason: 'last weight' }); assert.equal(await weight(), null);
});

test('列表默认仅有效记录，撤回游标仍可续页，状态/类型/时间过滤及overview一致', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const records = [];
  for (const day of [15, 16, 17]) records.push(await f.service.create(f.author, note(f.pet, `2026-11-${day}T03:00:00Z`, `day ${day}`)));
  const first = await f.service.list(f.viewer, f.pet, { limit: 1 });
  assert.equal(first.items[0].id, records[2].id); assert.equal(first.next_cursor, records[2].id);
  await f.service.withdraw(f.author, first.items[0].id, { reason: 'pagination anchor withdrawn' });
  const following = await f.service.list(f.viewer, f.pet, { limit: 1, cursor: first.next_cursor });
  assert.equal(following.items[0].id, records[1].id);
  assert.deepEqual((await f.service.list(f.viewer, f.pet, {})).items.map(row => row.id), [records[1].id, records[0].id]);
  assert.equal((await f.service.list(f.viewer, f.pet, { status: 'active' })).items.length, 2);
  assert.deepEqual((await f.service.list(f.viewer, f.pet, { status: 'withdrawn', type: 'note', from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' })).items.map(row => row.id), [records[2].id]);
  assert.equal((await f.service.list(f.viewer, f.pet, { status: 'all' })).items.length, 3);
  await assert.rejects(f.service.list(f.viewer, f.pet, { status: 'unknown' }));
  assert.deepEqual((await f.service.overview(f.viewer, f.pet, { date: '2026-11-17' })).care_records, []);
});

test('较早备份重放撤回日志防止复活，系统标记不泄露原理由且重复/缺失重放无副作用', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const input = note(f.pet, f.db.now()), record = await f.service.create(f.author, input, 'backup-create');
  const backup = new Map<string, Row[]>();
  for (const table of tables) backup.set(table, await f.db.all(`SELECT * FROM ${table}`));
  const restored = new Db(':memory:', f.db.clock); t.after(() => restored.close());
  for (const [table, rows] of backup) for (const row of rows) {
    const columns = Object.keys(row);
    await restored.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]));
  }
  const withdrawn = await f.service.withdraw(f.author, record.id, { reason: 'private source-only reason' });
  const receipts = await f.privacy.receipts(), replay = new PrivacyService(restored), care = new CareService(restored);
  assert.deepEqual(await replay.replay(receipts), { applied: 1, total: 1 });
  const current = await care.get(f.owner, record.id);
  assert.equal(current.withdrawn_at, withdrawn.withdrawn_at); assert.equal(current.withdrawn_by, null);
  assert.equal(current.withdrawal_reason, '恢复撤回记录');
  assert.equal((await care.list(f.owner, f.pet, {})).items.length, 0);
  assert.deepEqual(await care.create(f.author, input, 'backup-create'), record);
  assert.equal((await care.get(f.owner, record.id)).withdrawn_at, withdrawn.withdrawn_at);
  const snapshot = await restored.all('SELECT * FROM care_record_revisions ORDER BY id');
  assert.equal(snapshot.length, 0);
  const systemAudit = await restored.get("SELECT * FROM audit_logs WHERE resource_id=? AND action='care.withdrawal_replayed'", record.id);
  assert.equal(systemAudit!.actor_id, null);
  assert.ok(!systemAudit!.metadata_json.includes('private source-only reason'));
  assert.deepEqual(await replay.replay(receipts), { applied: 0, total: 1 });
  assert.deepEqual(await restored.all('SELECT * FROM care_record_revisions ORDER BY id'), snapshot);
  assert.deepEqual(await f.privacy.replay(receipts), { applied: 0, total: 1 });
  assert.equal((await f.service.get(f.owner, record.id)).withdrawal_reason, 'private source-only reason');
  const duplicateResource = { ...receipts[0], id: randomUUID(), deleted_at: new Date(Date.parse(receipts[0].deleted_at) + 1).toISOString() };
  assert.deepEqual(await f.privacy.replay([duplicateResource]), { applied: 1, total: 1 });
  assert.equal((await f.service.get(f.owner, record.id)).withdrawal_reason, 'private source-only reason');
  assert.equal((await f.service.history(f.owner, record.id)).revisions.length, 1);
  const missing = { ...duplicateResource, id: randomUUID(), resource_id: randomUUID() };
  assert.deepEqual(await replay.replay([missing]), { applied: 1, total: 1 });
  assert.equal(await restored.get('SELECT id FROM care_records WHERE id=?', missing.resource_id), undefined);
  assert.equal((await restored.get('SELECT COUNT(*) AS n FROM care_records'))!.n, 1);
});
