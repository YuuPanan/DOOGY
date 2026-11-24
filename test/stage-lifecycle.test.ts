import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { AccountExportService } from '../src/account-export';
import { PrivacyService } from '../src/privacy';
import { RetentionService } from '../src/retention';
import { openBackendFixture } from './backend-fixture';

const password = 'Synthetic-stage-lifecycle-2026';
const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;

async function fixture() {
  process.env.DATA_MODE = 'offline';
  const backend = await openBackendFixture(() => new Date('2026-11-24T04:00:00.000Z')), db = backend.db;
  const identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `stage-lifecycle-${name}@example.invalid`, password });
  const owner = await register('owner'), member = await register('member'), viewer = await register('viewer'), outsider = await register('outsider');
  for (const [account, role] of [[member, 'caregiver'], [viewer, 'viewer']] as const) {
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: account.user.email, role });
    await identity.accept(account.user.id, invitation.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Stage lifecycle pet' });
  const otherPet = await identity.createPet(outsider.user.id, { household_id: outsider.household.id, name: 'Unrelated pet' });
  const avatarId = db.id(), bytes = Buffer.from('stage-lifecycle-original-avatar');
  await db.run('INSERT INTO pet_avatars VALUES (?,?,?,?,?,?,?,?,?)', pet.id, avatarId, 'image/png', bytes.length,
    createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), 1, member.user.id, db.now());
  const goalIds: string[] = [], checkIds: string[] = [];
  for (const version of [1, 2]) {
    const goal = db.id(), check = db.id(); goalIds.push(goal); checkIds.push(check);
    await db.run('INSERT INTO pet_goals VALUES (?,?,?,?,?,?,?,?,?)', goal, pet.id, '2020-01-01', version,
      JSON.stringify({ active_minutes: version * 20, steps: null, intake_kcal: 500 }),
      version === 1 ? null : JSON.stringify({ name: 'Explicit user plan', version: 'user-v1' }), 'owner', member.user.id, db.now());
    await db.run('INSERT INTO body_check_ins VALUES (?,?,?,?,?,?,?,?,?,?,?)', check, pet.id, '2020-01-01', 'Asia/Shanghai', version,
      '2020-01-01T04:00:00.000Z', JSON.stringify({ appetite: 'owner-described', energy: null, movement: null, stool: null }),
      `Shared observation version ${version}`, null, member.user.id, db.now());
  }
  await db.run(`INSERT INTO user_profiles VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name`, member.user.id, 'Lifecycle member', 1, db.now());
  await db.run('INSERT INTO user_consents VALUES (?,?,?,?,?,?,?)', db.id(), member.user.id, 'provided-terms-v1', 'provided-privacy-v1', db.now(), 'test', 1);
  await db.run('INSERT INTO user_onboarding VALUES (?,?,?,?,?,?)', member.user.id, pet.id, 'skipped', null, 1, db.now());
  return { ...backend, db, identity, owner, member, viewer, outsider, pet, otherPet, avatarId, bytes, goalIds, checkIds,
    exporter: new AccountExportService(db), privacy: new PrivacyService(db), retention: new RetentionService(db) };
}

test('第一批数据导出：全部目标和观察版本、头像原文与个人状态按归属授权', async t => {
  const f = await fixture(); t.after(f.close);
  const scope = { household_id: f.owner.household.id };
  const goals = await f.exporter.page(f.viewer.user.id, 'pet_goals', scope);
  assert.equal(goals.items.length, 2);
  assert.deepEqual(goals.items.map((row: Row) => row.version).sort(), [1, 2]);
  assert.equal(goals.items.find((row: Row) => row.version === 1).plan, null);
  assert.equal(goals.items.find((row: Row) => row.version === 2).plan.name, 'Explicit user plan');
  assert.equal(goals.items[0].targets.steps, null);
  const checks = await f.exporter.page(f.viewer.user.id, 'body_check_ins', scope);
  assert.equal(checks.items.length, 2); assert.equal(checks.items[0].values.energy, null);
  assert.ok(!Object.hasOwn(checks.items[0], 'values_json'));
  const avatars = await f.exporter.page(f.viewer.user.id, 'pet_avatars', scope);
  assert.equal(avatars.items.length, 1); assert.deepEqual(Buffer.from(avatars.items[0].content_base64, 'base64'), f.bytes);
  assert.equal((await f.exporter.page(f.member.user.id, 'user_profiles', {})).items[0].display_name, 'Lifecycle member');
  assert.equal((await f.exporter.page(f.member.user.id, 'user_consents', {})).items[0].version, 1);
  assert.equal((await f.exporter.page(f.member.user.id, 'user_onboarding', {})).items[0].pet_id, f.pet.id);
  assert.equal((await f.exporter.page(f.outsider.user.id, 'user_consents', {})).items.length, 0);
  await assert.rejects(f.exporter.page(f.outsider.user.id, 'pet_goals', scope), status(404));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  await assert.rejects(f.exporter.page(f.viewer.user.id, 'body_check_ins', scope), status(404));
});

test('注销清个人资料并匿名化共享作者，保留全家庭目标、观察和头像', async t => {
  const f = await fixture(); t.after(f.close);
  await f.privacy.closeAccount(f.member.user.id, { password, confirmation: 'DELETE' });
  for (const table of ['user_profiles','user_consents','user_onboarding']) {
    assert.equal((await f.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`, f.member.user.id))!.n, 0);
  }
  for (const [table, count] of [['pet_goals', 2], ['body_check_ins', 2], ['pet_avatars', 1]] as const) {
    const rows = await f.db.all(`SELECT created_by FROM ${table} WHERE pet_id=?`, f.pet.id);
    assert.equal(rows.length, count); assert.ok(rows.every(row => row.created_by === null));
  }
  assert.equal((await f.exporter.page(f.owner.user.id, 'pet_goals', { household_id: f.owner.household.id })).items.length, 2);
  await assert.rejects(f.identity.userFromAccess(f.member.access_token), status(401));
});

test('持久手工记录不套用遥测期限；删除宠物清全部版本、头像和回执副本，其他家庭保留', async t => {
  const f = await fixture(); t.after(f.close);
  await f.retention.update(f.owner.user.id, f.owner.household.id, { password, enabled: true, telemetry_days: 1, activity_days: 1, safety_days: 1 });
  const preview = (await f.retention.preview(f.owner.user.id, f.owner.household.id)).households[0];
  assert.deepEqual(preview.retained_counts, { pet_goals: 2, body_check_ins: 2, pet_avatars: 1, pet_media: 0, behavior_records: 0,
    interpretations: 0, assistant_conversations: 0, assistant_messages: 0 });
  await f.retention.execute(f.owner.user.id, f.owner.household.id, { password });
  const deletion = await f.privacy.petPreview(f.owner.user.id, f.pet.id);
  assert.equal(deletion.counts.pet_goals, 2); assert.equal(deletion.counts.body_check_ins, 2); assert.equal(deletion.counts.pet_avatars, 1);
  await f.db.idempotent(f.owner.user.id, 'stage-lifecycle-copy', 'goal-copy', {}, () => ({ id: f.goalIds[0] }));
  await assert.rejects(f.privacy.deletePet(f.viewer.user.id, f.pet.id, { password, confirmation: f.pet.id }), status(403));
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  for (const table of ['pet_goals','body_check_ins','pet_avatars']) assert.equal((await f.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE pet_id=?`, f.pet.id))!.n, 0);
  assert.equal((await f.db.get('SELECT pet_id FROM user_onboarding WHERE user_id=?', f.member.user.id))!.pet_id, null);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE scope=?', 'stage-lifecycle-copy'), undefined);
  assert.ok(await f.db.pet(f.outsider.user.id, f.otherPet.id));
});

test('头像替换删除日志重放清旧正文和回执，保留后来保存的新头像', async t => {
  const f = await fixture(); t.after(f.close);
  await f.db.idempotent(f.owner.user.id, 'stage-avatar-copy', 'old-copy', {}, () => ({ id: f.avatarId }));
  const receipt = { id: f.db.id(), kind: 'pet_avatar', resource_id: f.avatarId, deleted_at: f.db.now() };
  assert.equal((await f.privacy.replay([receipt])).applied, 1);
  assert.equal(await f.db.get('SELECT id FROM pet_avatars WHERE id=?', f.avatarId), undefined);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE scope=?', 'stage-avatar-copy'), undefined);
  const next = f.db.id();
  await f.db.run('INSERT INTO pet_avatars VALUES (?,?,?,?,?,?,?,?,?)', f.pet.id, next, 'image/png', f.bytes.length,
    createHash('sha256').update(f.bytes).digest('hex'), f.bytes.toString('base64'), 2, f.owner.user.id, f.db.now());
  await f.privacy.replay([{ ...receipt, id: f.db.id() }]);
  assert.equal((await f.db.get('SELECT id FROM pet_avatars WHERE pet_id=?', f.pet.id))!.id, next);
});
