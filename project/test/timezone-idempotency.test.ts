import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { CareService } from '../src/care';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
async function fixture() {
  const db = new Db(':memory:', () => new Date('2026-03-08T07:30:00Z'));
  const identity = new IdentityService(db), care = new CareService(db);
  const owner = await identity.register({ email: 'timezone-owner@example.invalid', password: 'Synthetic-timezone-password', timezone: 'America/New_York' });
  const member = await identity.register({ email: 'timezone-member@example.invalid', password: 'Synthetic-timezone-password' });
  const invite = await identity.invite(owner.user.id, owner.household.id, { email: member.user.email, role: 'caregiver' });
  await identity.accept(member.user.id, invite.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '时区测试宠物' });
  return { db, identity, care, owner, member, pet };
}

test('家庭时区持久化，宠物覆盖与查询覆盖按优先级处理，夏令时自然日正确', async () => {
  const { db, identity, care, owner, pet } = await fixture();
  try {
    assert.equal(owner.household.timezone, 'America/New_York');
    assert.equal((await identity.households(owner.user.id)).items[0].timezone, 'America/New_York');
    assert.equal(pet.timezone, null);
    assert.equal(pet.effective_timezone, 'America/New_York');
    const inherited = await care.daily(owner.user.id, pet.id, { date: '2026-03-08' });
    assert.equal(inherited.timezone, 'America/New_York');
    assert.equal((Date.parse(inherited.period_end) - Date.parse(inherited.period_start)) / 3_600_000, 23);
    await identity.updatePet(owner.user.id, pet.id, { timezone: 'Asia/Tokyo' });
    assert.equal((await care.daily(owner.user.id, pet.id, {})).timezone, 'Asia/Tokyo');
    assert.equal((await care.weekly(owner.user.id, pet.id, {})).timezone, 'Asia/Tokyo');
    assert.equal((await care.features(owner.user.id, pet.id, {})).timezone, 'Asia/Tokyo');
    assert.equal((await care.overview(owner.user.id, pet.id, {})).pet.effective_timezone, 'Asia/Tokyo');
    assert.equal((await care.daily(owner.user.id, pet.id, { timezone: 'UTC' })).timezone, 'UTC');
    await identity.updateHousehold(owner.user.id, owner.household.id, { timezone: 'Europe/London', name: '新的家庭名' });
    assert.equal((await care.daily(owner.user.id, pet.id, {})).timezone, 'Asia/Tokyo');
    await identity.updatePet(owner.user.id, pet.id, { timezone: null });
    assert.equal((await identity.getPet(owner.user.id, pet.id)).effective_timezone, 'Europe/London');
    assert.equal((await care.daily(owner.user.id, pet.id, {})).timezone, 'Europe/London');
    assert.equal((await identity.households(owner.user.id)).items[0].name, '新的家庭名');
    assert.equal((await db.get('SELECT timezone FROM household_settings WHERE household_id=?', owner.household.id))!.timezone, 'Europe/London');
  } finally { await db.close(); }
});

test('时区配置校验与家庭所有者权限，宠物写权限和旧家庭默认值保持', async () => {
  const { db, identity, care, owner, member, pet } = await fixture();
  try {
    await assert.rejects(async () => await identity.updateHousehold(member.user.id, owner.household.id, { timezone: 'UTC' }), status(403));
    await assert.rejects(async () => await identity.updateHousehold(owner.user.id, owner.household.id, { timezone: 'Invalid/Timezone' }));
    await assert.rejects(async () => await identity.updatePet(owner.user.id, pet.id, { timezone: '+08:00' }));
    await assert.rejects(async () => await care.daily(owner.user.id, pet.id, { timezone: 'Invalid/Timezone' }));
    await identity.changeMember(owner.user.id, owner.household.id, member.user.id, { role: 'viewer' });
    await assert.rejects(async () => await identity.updatePet(member.user.id, pet.id, { timezone: 'UTC' }), status(403));
    await db.run('DELETE FROM household_settings WHERE household_id=?', owner.household.id);
    assert.equal((await identity.getPet(owner.user.id, pet.id)).effective_timezone, 'Asia/Shanghai');
    assert.equal((await care.daily(owner.user.id, pet.id, {})).timezone, 'Asia/Shanghai');
    assert.equal((await identity.households(owner.user.id)).items[0].timezone, 'Asia/Shanghai');
    await assert.rejects(async () => await identity.updateHousehold(owner.user.id, owner.household.id, {}), status(400));
  } finally { await db.close(); }
});

test('宠物创建幂等保持相同结果和单次审计，不同参数冲突且重放重新检查当前权限', async () => {
  const { db, identity, owner, member } = await fixture();
  try {
    const input = { household_id: owner.household.id, name: '幂等宠物', timezone: 'UTC' };
    const first = await identity.createPet(member.user.id, input, 'create-pet-key');
    assert.deepEqual((await identity.createPet(member.user.id, { timezone: 'UTC', name: '幂等宠物', household_id: owner.household.id }, 'create-pet-key')), first);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM pets WHERE name=?', '幂等宠物'))!.count, 1);
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action='pet.create' AND resource_id=?", first.id))!.count, 1);
    await assert.rejects(async () => await identity.createPet(member.user.id, { ...input, name: '其他宠物' }, 'create-pet-key'), status(409));
    await identity.revokeMember(owner.user.id, owner.household.id, member.user.id);
    await assert.rejects(async () => await identity.createPet(member.user.id, input, 'create-pet-key'), status(404));
  } finally { await db.close(); }
});

test('照护创建幂等不重复体重或审计，冲突及撤权不会读取缓存结果', async () => {
  const { db, identity, care, owner, member, pet } = await fixture();
  try {
    const input = { pet_id: pet.id, type: 'weight', value: { weight_kg: 12.5 }, recorded_at: db.now(), source: 'owner' };
    const first = await care.create(member.user.id, input, 'create-care-key');
    assert.deepEqual((await care.create(member.user.id, input, 'create-care-key')), first);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM care_records WHERE pet_id=?', pet.id))!.count, 1);
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action='care.created' AND resource_id=?", first.id))!.count, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM care_record_revisions WHERE record_id=?', first.id))!.count, 0);
    assert.equal((await identity.getPet(owner.user.id, pet.id)).weight_kg, 12.5);
    await assert.rejects(async () => await care.create(member.user.id, { ...input, value: { weight_kg: 13 } }, 'create-care-key'), status(409));
    await identity.changeMember(owner.user.id, owner.household.id, member.user.id, { role: 'viewer' });
    await assert.rejects(async () => await care.create(member.user.id, input, 'create-care-key'), status(403));
    await identity.revokeMember(owner.user.id, owner.household.id, member.user.id);
    await assert.rejects(async () => await care.create(member.user.id, input, 'create-care-key'), status(404));
  } finally { await db.close(); }
});

test('创建和撤权并发时，权限检查、幂等重放和写入保持同一事务顺序', async () => {
  const { db, identity, care, owner, member, pet } = await fixture();
  try {
    const [createdPet, record] = await Promise.all([
      identity.createPet(member.user.id, { household_id: owner.household.id, name: '事务内创建' }, 'concurrent-pet'),
      care.create(member.user.id, { pet_id: pet.id, type: 'note', value: {}, recorded_at: db.now() }, 'concurrent-care'),
      identity.revokeMember(owner.user.id, owner.household.id, member.user.id),
    ]);
    const changes = await db.all(`SELECT action FROM audit_logs WHERE
      (action='pet.create' AND resource_id=?) OR (action='care.created' AND resource_id=?)
      OR (action='household.member.revoke' AND resource_id=?) ORDER BY rowid`, createdPet.id, record.id, owner.household.id);
    assert.deepEqual(changes.map(row => row.action), ['pet.create', 'care.created', 'household.member.revoke']);
    await assert.rejects(() => identity.createPet(member.user.id, { household_id: owner.household.id, name: '事务内创建' }, 'concurrent-pet'), status(404));
    await assert.rejects(() => care.create(member.user.id, { pet_id: pet.id, type: 'note', value: {}, recorded_at: db.now() }, 'concurrent-care'), status(404));
  } finally { await db.close(); }
});
