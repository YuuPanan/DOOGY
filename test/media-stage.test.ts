import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { MediaService, mediaByteRange } from '../src/media';
import { insertSyntheticMedia } from './media-fixture';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;

test('媒体单段Range：普通、开放末尾、后缀、末尾裁剪及无效范围', () => {
  assert.deepEqual(mediaByteRange(undefined, 10), { start: 0, end: 9 });
  assert.deepEqual(mediaByteRange('bytes=0-0', 10), { start: 0, end: 0 });
  assert.deepEqual(mediaByteRange('bytes=3-', 10), { start: 3, end: 9 });
  assert.deepEqual(mediaByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(mediaByteRange('bytes=3-100', 10), { start: 3, end: 9 });
  assert.deepEqual(mediaByteRange('bytes=-100', 10), { start: 0, end: 9 });
  for (const value of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'items=0-1', 'bytes=1.2-3', 'bytes=9007199254740993-', 'bytes=0-9007199254740993']) assert.equal(mediaByteRange(value, 10), null, value);
});

test('媒体元数据与正文按当前家庭授权，分页不带正文且游标绑定用户和宠物', async () => {
  const db = new Db(':memory:', () => new Date('2026-11-24T07:00:00Z'));
  try {
    const identity = new IdentityService(db), media = new MediaService(db);
    const owner = await identity.register({ email: 'media-owner@example.invalid', password: 'password123' });
    const viewer = await identity.register({ email: 'media-viewer@example.invalid', password: 'password123' });
    const outsider = await identity.register({ email: 'media-other@example.invalid', password: 'password123' });
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Synthetic media pet' });
    const otherPet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Other pet' });
    const invite = await identity.invite(owner.user.id, owner.household.id, { email: viewer.user.email, role: 'viewer' }); await identity.accept(viewer.user.id, invite.token);
    const first = await insertSyntheticMedia(db, pet.id, owner.user.id), second = await insertSyntheticMedia(db, pet.id, owner.user.id);
    const metadata = await media.metadata(viewer.user.id, first.id); assert.equal(metadata.sha256, first.sha256); assert.equal(metadata.content_base64, undefined);
    assert.equal(metadata.validation.method, 'synthetic_test_fixture'); assert.equal(metadata.source, 'synthetic'); assert.equal(metadata.captured_at, first.captured_at);
    const page = await media.list(owner.user.id, pet.id, { limit: 1 }); assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
    const last = await media.list(owner.user.id, pet.id, { limit: 1, cursor: page.next_cursor }); assert.equal(last.next_cursor, null);
    assert.deepEqual([...page.items, ...last.items].map((row: { id: string }) => row.id).sort(), [first.id, second.id].sort());
    await assert.rejects(media.list(viewer.user.id, pet.id, { cursor: page.next_cursor }), status(400));
    await assert.rejects(media.list(owner.user.id, otherPet.id, { cursor: page.next_cursor }), status(400));
    const full = await media.content(viewer.user.id, first.id); assert.equal(full.status, 200); assert.deepEqual(full.buffer, first.bytes);
    const part = await media.content(viewer.user.id, first.id, 'bytes=5-12'); assert.equal(part.status, 206); assert.deepEqual(part.buffer, first.bytes.subarray(5, 13));
    assert.equal((await media.content(viewer.user.id, first.id, `bytes=${first.size_bytes}-`)).status, 416);
    await assert.rejects(media.content(outsider.user.id, first.id, 'malformed'), status(404));
    await assert.rejects(media.delete(viewer.user.id, first.id), status(403));
    await identity.revokeMember(owner.user.id, owner.household.id, viewer.user.id);
    await assert.rejects(media.metadata(viewer.user.id, first.id), status(404));
    await assert.rejects(media.content(viewer.user.id, first.id), status(404));
  } finally { await db.close(); }
});

test('媒体删除清除正文并写恢复删除日志，旧路径不能读取', async () => {
  const db = new Db(':memory:');
  try {
    const identity = new IdentityService(db), media = new MediaService(db);
    const owner = await identity.register({ email: 'media-delete@example.invalid', password: 'password123' });
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Delete media pet' });
    const fixture = await insertSyntheticMedia(db, pet.id, owner.user.id);
    const result = await media.delete(owner.user.id, fixture.id); assert.equal(result.deleted, true);
    assert.equal(await db.get('SELECT id FROM pet_media WHERE id=?', fixture.id), undefined);
    assert.equal((await db.get('SELECT kind FROM privacy_deletions WHERE resource_id=?', fixture.id))!.kind, 'pet_media');
    await assert.rejects(media.content(owner.user.id, fixture.id), status(404));
    await assert.rejects(media.delete(owner.user.id, fixture.id), status(404));
  } finally { await db.close(); }
});
