import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { boundedRange } from '../src/http';
import { IdentityService } from '../src/identity';
import { provisionDevice, DevicesService } from '../src/devices';
import { SafetyService } from '../src/safety';
import { FencesService } from '../src/fences';

const isCode = (status: number, code?: string) => (error: unknown) => error instanceof HttpException && error.getStatus() === status && (!code || (error.getResponse() as any).code === code);
async function setup() {
  const db = new Db(':memory:', () => new Date('2026-11-17T06:00:00Z'));
  const identity = new IdentityService(db);
  const owner = (await identity.register({ email: 'workflow@example.invalid', password: 'Synthetic-workflow-2026' }));
  const pet = (await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '流程宠物' }));
  return { db, identity, owner, pet };
}

test('关键写幂等响应与业务同时提交，冲突不覆盖，失败不占用键', async () => {
  const { db, owner } = (await setup());
  try {
    const work = async () => { const id = db.id(); await db.audit(owner.user.id, 'test.created', id); return { id }; };
    const first = (await db.idempotent(owner.user.id, 'test', 'key1', { name: 'a', count: 1 }, work));
    assert.deepEqual((await db.idempotent(owner.user.id, 'test', 'key1', { count: 1, name: 'a' }, work)), first);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='test.created'"))!.n, 1);
    await assert.rejects(async () => (await db.idempotent(owner.user.id, 'test', 'key1', { name: 'b' }, work)), isCode(409, 'IDEMPOTENCY_CONFLICT'));
    await assert.rejects(async () => (await db.idempotent(owner.user.id, 'test', 'bad', {}, async () => { await db.audit(null, 'test.rollback', 'x'); throw new Error('failed'); })), /failed/);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='test.rollback'"))!.n, 0);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key='bad'"))!.n, 0);
    assert.ok((await db.idempotent(owner.user.id, 'test', 'bad', {}, work)).id);
    assert.notEqual((await db.idempotent(owner.user.id, 'other-scope', 'key1', {}, work)).id, first.id);
  } finally { await db.close(); }
});

test('轨迹范围默认24小时，显式上界半开区间，最多31天', () => {
  const now = new Date('2026-11-17T06:00:00Z');
  const range = boundedRange(undefined, undefined, now);
  assert.equal(Date.parse(range.to) - Date.parse(range.from), 86400_000);
  assert.ok(Date.parse(range.to) > now.getTime());
  assert.equal(boundedRange('2026-11-01T08:00:00+08:00', '2026-11-02T00:00:00Z', now).from, '2026-11-01T00:00:00.000Z');
  assert.throws(() => boundedRange('2026-01-01T00:00:00Z', undefined, now), isCode(400, 'RANGE_TOO_LARGE'));
  assert.throws(() => boundedRange('2026-11-18T00:00:00Z', '2026-11-17T00:00:00Z', now), isCode(400, 'INVALID_RANGE'));
});

test('安全事件确认不关闭风险，重复确认不改操作者，撤权立即阻断', async () => {
  const { db, owner, pet, identity } = (await setup());
  try {
    const device = (await provisionDevice(db, { serial_no: 'ACK-WORKFLOW' }));
    await new DevicesService(db).claim(owner.user.id, { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    const id = db.id();
    await db.run('INSERT INTO safety_events(id,pet_id,device_id,type,occurred_at,details_json) VALUES (?,?,?,?,?,?)', id, pet.id, device.device_id, 'battery.low', db.now(), '{}');
    const service = new SafetyService(db);
    const ack = (await service.acknowledge(owner.user.id, id, { note: '正在处理' }, 'ack1'));
    assert.equal(ack.event_status, 'open');
    assert.equal(ack.event_closed_at, null);
    assert.deepEqual((await service.acknowledge(owner.user.id, id, { note: '正在处理' }, 'ack1')), ack);
    assert.equal((await service.acknowledge(owner.user.id, id, {})).user_id, owner.user.id);
    assert.equal((await service.detail(owner.user.id, id)).delivery_status, 'unknown');
    const visitor = (await identity.register({ email: 'workflow-viewer@example.invalid', password: 'Synthetic-workflow-2026' }));
    const invite = (await identity.invite(owner.user.id, owner.household.id, { email: visitor.user.email, role: 'viewer' }));
    await identity.accept(visitor.user.id, invite.token);
    assert.equal((await service.detail(visitor.user.id, id)).id, id);
    await assert.rejects(async () => (await service.acknowledge(visitor.user.id, id, {})), isCode(403));
    await identity.revokeMember(owner.user.id, owner.household.id, visitor.user.id);
    await assert.rejects(async () => (await service.detail(visitor.user.id, id)), isCode(404));
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='safety.acknowledged'"))!.n, 1);
  } finally { await db.close(); }
});

test('异步等待写事务期间撤权，围栏写入和安全确认幂等重放均重新检查权限', async () => {
  for (const action of ['fence-create', 'fence-update', 'ack-replay']) {
    const { db, owner, pet, identity } = await setup();
    try {
      const caregiver = await identity.register({ email: 'workflow-caregiver@example.invalid', password: 'Synthetic-workflow-2026' });
      const invite = await identity.invite(owner.user.id, owner.household.id, { email: caregiver.user.email, role: 'caregiver' });
      await identity.accept(caregiver.user.id, invite.token);
      const fences = new FencesService(db), safety = new SafetyService(db);
      const input = { pet_id: pet.id, name: '事务围栏', geometry: { type: 'circle', lat: 31, lon: 121, radius_m: 100 } };
      const fence = action === 'fence-update' ? await fences.create(owner.user.id, input) : null;
      const eventId = db.id();
      if (action === 'ack-replay') {
        const device = await provisionDevice(db, { serial_no: 'ASYNC-ACK' });
        await db.run('INSERT INTO safety_events(id,pet_id,device_id,type,occurred_at,details_json) VALUES (?,?,?,?,?,?)', eventId, pet.id, device.device_id, 'battery.low', db.now(), '{}');
        await safety.acknowledge(caregiver.user.id, eventId, {}, 'same-ack');
      }
      const transaction = db.transaction.bind(db);
      let revoke = true;
      db.transaction = async <T>(work: () => T | Promise<T>): Promise<T> => {
        if (revoke) {
          revoke = false;
          await identity.revokeMember(owner.user.id, owner.household.id, caregiver.user.id);
        }
        return transaction(work);
      };
      const request = action === 'fence-create' ? fences.create(caregiver.user.id, input, 'new-fence')
        : action === 'fence-update' ? fences.update(caregiver.user.id, fence!.id, { name: '未经授权的改名' })
        : safety.acknowledge(caregiver.user.id, eventId, {}, 'same-ack');
      await assert.rejects(request, isCode(404));
      if (action === 'fence-create') assert.equal((await db.get('SELECT COUNT(*) AS n FROM geofences'))!.n, 0);
      if (fence) assert.equal((await db.get('SELECT name FROM geofences WHERE id=?', fence.id))!.name, input.name);
    } finally { await db.close(); }
  }
});
