import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { ProfileService } from '../src/profile';
import { DevicesService, provisionDevice } from '../src/devices';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1cAAAAASUVORK5CYII=', 'base64');

test('显示名、条款版本与跳过引导在重新登录后可读，完成连接由真实绑定及接收状态推导', async () => {
  const db = new Db(':memory:', () => new Date('2026-11-24T01:00:00Z'));
  try {
    const identity = new IdentityService(db), profiles = new ProfileService(db);
    const owner = await identity.register({ email: 'profile@example.invalid', password: 'password123', display_name: '  Baku owner  ', consent: { terms_version: 'terms-reviewed-v1', privacy_version: 'privacy-reviewed-v2', source: 'web-register' } });
    assert.equal(owner.user.display_name, 'Baku owner'); assert.equal(owner.user.profile_version, 1);
    assert.equal(owner.user.consent!.accepted_at, db.now()); assert.equal(owner.user.consent!.privacy_version, 'privacy-reviewed-v2');
    const old = await identity.register({ email: 'legacy-profile@example.invalid', password: 'password123' });
    assert.equal(old.user.display_name, null); assert.equal(old.user.consent, null); assert.equal(old.user.profile_version, 0);
    const changed = await profiles.update(owner.user.id, { display_name: 'Ada', expected_version: 1 }, 'profile-change');
    assert.equal(changed.profile_version, 2);
    assert.deepEqual(await profiles.update(owner.user.id, { display_name: 'Ada', expected_version: 1 }, 'profile-change'), changed);
    await assert.rejects(profiles.update(owner.user.id, { display_name: 'stale', expected_version: 1 }), status(409));
    assert.equal((await identity.login({ email: owner.user.email, password: 'password123' })).user.display_name, 'Ada');
    assert.equal((await identity.me(owner.user.id)).display_name, 'Ada');
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Baku' });
    assert.equal((await profiles.onboarding(owner.user.id)).next_step, 'create_or_select_pet');
    const skipped = await profiles.updateOnboarding(owner.user.id, { pet_id: pet.id, collar_choice: 'skipped', completed: true, expected_version: 0 }, 'skip');
    assert.equal(skipped.next_step, 'done'); assert.equal(skipped.device_report.status, 'unbound'); assert.equal(skipped.bluetooth.status, 'unknown');
    await assert.rejects(profiles.updateOnboarding(owner.user.id, { collar_choice: 'completed', expected_version: 1 }), status(409));
    const device = await provisionDevice(db, { serial_no: 'onboarding-device' });
    await new DevicesService(db).claim(owner.user.id, { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    const bound = await profiles.updateOnboarding(owner.user.id, { collar_choice: 'completed', completed: true, expected_version: 1 });
    assert.equal(bound.next_step, 'done'); assert.equal(bound.device_report.status, 'waiting'); assert.equal(bound.binding.device_id, device.device_id);
    await db.run('UPDATE device_state SET last_seen_at=?,reported_at=? WHERE device_id=?', db.now(), '2026-11-24T00:59:00.000Z', device.device_id);
    assert.equal((await profiles.onboarding(owner.user.id)).device_report.status, 'received');
    await new DevicesService(db).unbind(owner.user.id, device.device_id);
    assert.equal((await profiles.onboarding(owner.user.id)).next_step, 'connect_collar');
    const outsiderPet = await identity.createPet(old.user.id, { household_id: old.household.id, name: 'Other' });
    await assert.rejects(profiles.updateOnboarding(owner.user.id, { pet_id: outsiderPet.id, expected_version: 2 }), status(404));
  } finally { await db.close(); }
});

test('头像替换有版本和幂等、验证类型及大小，旧正文清除并记录删除日志，撤权立即禁止读取', async () => {
  const db = new Db(':memory:');
  try {
    const identity = new IdentityService(db), profiles = new ProfileService(db);
    const owner = await identity.register({ email: 'avatar-owner@example.invalid', password: 'password123' });
    const viewer = await identity.register({ email: 'avatar-viewer@example.invalid', password: 'password123' });
    const invite = await identity.invite(owner.user.id, owner.household.id, { email: viewer.user.email, role: 'viewer' });
    await identity.accept(viewer.user.id, invite.token);
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Baku' });
    const upload = { mimetype: 'image/png', buffer: png };
    const first = await profiles.avatar(owner.user.id, pet.id, { expected_version: 0 }, upload, 'first');
    assert.equal(first.version, 1); assert.equal(first.size_bytes, png.length); assert.equal(first.content_base64, undefined);
    assert.deepEqual(await profiles.avatar(owner.user.id, pet.id, { expected_version: 0 }, upload, 'first'), first);
    assert.deepEqual((await profiles.avatarContent(viewer.user.id, pet.id)).buffer, png);
    await assert.rejects(profiles.avatar(viewer.user.id, pet.id, { expected_version: 1 }, upload), status(403));
    await assert.rejects(profiles.avatar(owner.user.id, pet.id, { expected_version: 0 }, upload), status(409));
    await assert.rejects(profiles.avatar(owner.user.id, pet.id, { expected_version: 1 }, { mimetype: 'application/pdf', buffer: Buffer.from('%PDF-test') }), status(415));
    await assert.rejects(profiles.avatar(owner.user.id, pet.id, { expected_version: 1 }, { mimetype: 'image/png', buffer: Buffer.from('not image') }), status(400));
    await assert.rejects(profiles.avatar(owner.user.id, pet.id, { expected_version: 1 }, { mimetype: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }), status(413));
    const second = await profiles.avatar(owner.user.id, pet.id, { expected_version: 1 }, upload);
    assert.equal(second.version, 2); assert.notEqual(second.id, first.id);
    await assert.rejects(profiles.avatarContent(owner.user.id, pet.id, { version: 1 }), status(404));
    assert.equal(await db.get('SELECT id FROM pet_avatars WHERE id=?', first.id), undefined);
    assert.equal((await db.get('SELECT kind FROM privacy_deletions WHERE resource_id=?', first.id))!.kind, 'pet_avatar');
    assert.equal((await identity.getPet(owner.user.id, pet.id)).avatar.id, second.id);
    await profiles.updateOnboarding(viewer.user.id, { pet_id: pet.id, collar_choice: 'skipped', expected_version: 0 });
    await identity.revokeMember(owner.user.id, owner.household.id, viewer.user.id);
    await assert.rejects(profiles.avatarContent(viewer.user.id, pet.id), status(404));
    assert.equal((await profiles.onboarding(viewer.user.id)).pet_id, null);
  } finally { await db.close(); }
});
