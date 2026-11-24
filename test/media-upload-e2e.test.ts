import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { IdentityService } from '../src/identity';
import { MediaService } from '../src/media';
import { mediaTools, mediaValidationAvailable, MAX_MEDIA_SIZE } from '../src/media-validation';
import { openBackendFixture } from './backend-fixture';

function wave(seconds = 1) {
  const size = seconds * 8000 * 2, file = Buffer.alloc(44 + size);
  file.write('RIFF'); file.writeUInt32LE(36 + size, 4); file.write('WAVEfmt ', 8); file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20); file.writeUInt16LE(1, 22); file.writeUInt32LE(8000, 24); file.writeUInt32LE(16000, 28);
  file.writeUInt16LE(2, 32); file.writeUInt16LE(16, 34); file.write('data', 36); file.writeUInt32LE(size, 40); return file;
}
async function fixture() {
  const backend = await openBackendFixture(), db = backend.db, identity = new IdentityService(db);
  const owner = await identity.register({ email: 'media-upload-owner@example.invalid', password: 'Synthetic-media-2026' });
  const viewer = await identity.register({ email: 'media-upload-viewer@example.invalid', password: 'Synthetic-media-2026' });
  const outsider = await identity.register({ email: 'media-upload-other@example.invalid', password: 'Synthetic-media-2026' });
  const invited = await identity.invite(owner.user.id, owner.household.id, { email: viewer.user.email, role: 'viewer' }); await identity.accept(viewer.user.id, invited.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Synthetic media pet' });
  const app = await createApp({ db, quiet: true }); await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/api/v1`;
  const capturedAt = new Date(db.clock().getTime() - 90000).toISOString();
  async function upload(bytes: Buffer, name = 'synthetic.wav', key = 'synthetic-media-upload', token = owner.access_token, fields: Record<string, string> = {}) {
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), name);
    form.set('captured_at', capturedAt); for (const [name, value] of Object.entries(fields)) form.set(name, value);
    const response = await fetch(`${base}/pets/${pet.id}/media`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, body: form });
    return { status: response.status, value: await response.json() as any };
  }
  return { ...backend, db, owner, viewer, outsider, pet, identity, base, upload, service: app.get(MediaService), close: async () => { await app.close(); await backend.close(); } };
}

test('media upload unavailable tools is explicit; current viewer/outsider cannot write', async () => {
  const f = await fixture(), previous = process.env.MEDIA_TOOLS_DIRECTORY;
  try {
    process.env.MEDIA_TOOLS_DIRECTORY = join(tmpdir(), 'doogy-tools-not-configured-interface-test');
    const cap = await f.service.capabilities(f.owner.user.id, f.pet.id); assert.equal(cap.upload_enabled, false); assert.equal(cap.reason, 'MEDIA_VALIDATOR_NOT_CONFIGURED');
    assert.equal((await f.upload(wave())).status, 503);
    assert.equal((await f.upload(wave(), undefined, undefined, f.viewer.access_token)).status, 403);
    assert.equal((await f.upload(wave(), undefined, undefined, f.outsider.access_token)).status, 404);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM pet_media'))!.n, 0);
  } finally { if (previous === undefined) delete process.env.MEDIA_TOOLS_DIRECTORY; else process.env.MEDIA_TOOLS_DIRECTORY = previous; await f.close(); }
});

test('real WAV multipart upload: decode, idempotency, authorized bytes/Range and source deletion', { skip: !mediaValidationAvailable() }, async () => {
  const f = await fixture();
  try {
    const file = wave(), created = await f.upload(file); assert.equal(created.status, 201, JSON.stringify(created));
    const media = created.value; assert.equal(media.pet_id, f.pet.id); assert.equal(media.source, 'owner_upload');
    assert.equal(media.content_type, 'audio/wav'); assert.equal(media.duration_seconds, 1); assert.equal(media.validation.decoded, true);
    assert.equal(media.sha256, createHash('sha256').update(file).digest('hex')); assert.ok(!('content_base64' in media));
    assert.equal((await f.upload(file)).value.id, media.id);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM pet_media'))!.n, 1);
    assert.equal((await f.upload(file, 'different.wav')).status, 409);
    const response = await fetch(f.base + `/media/${media.id}/content`, { headers: { authorization: `Bearer ${f.viewer.access_token}`, range: 'bytes=0-43' } });
    assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), file.subarray(0, 44));
    await f.service.delete(f.owner.user.id, media.id);
    await assert.rejects(f.service.metadata(f.viewer.user.id, media.id), error => (error as any).getStatus() === 404);
    assert.ok(await f.db.get("SELECT id FROM privacy_deletions WHERE kind='pet_media' AND resource_id=?", media.id));
  } finally { await f.close(); }
});

test('media upload rejects actual oversized duration, malformed bytes, future capture and excess size', { skip: !mediaValidationAvailable() }, async () => {
  const f = await fixture();
  try {
    for (const [bytes, expected] of [[Buffer.from('not audio, video or a valid container'), 400], [wave(61), 413]] as const) assert.equal((await f.upload(bytes)).status, expected);
    assert.equal((await f.upload(wave(), undefined, undefined, undefined, { captured_at: '2099-01-01T00:00:00Z' })).status, 400);
    assert.equal((await f.upload(wave(10), undefined, undefined, undefined, { captured_at: new Date(f.db.clock().getTime() - 1000).toISOString() })).status, 400);
    await assert.rejects(f.service.upload(f.owner.user.id, f.pet.id, { captured_at: f.db.now() }, { buffer: Buffer.alloc(MAX_MEDIA_SIZE + 1), originalname: 'oversize.wav', mimetype: 'audio/wav' }), error => (error as any).getStatus() === 413);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM pet_media'))!.n, 0);
  } finally { await f.close(); }
});

for (const format of ['m4a', 'mp3', 'mp4']) test(`real ${format} upload uses actual container/codec and decodes successfully`, { skip: !mediaValidationAvailable() }, async () => {
  const f = await fixture(), directory = mkdtempSync(join(tmpdir(), 'doogy-media-upload-fixture-')), output = join(directory, `synthetic.${format}`);
  try {
    const input = format === 'mp4' ? ['-f','lavfi','-i','color=c=green:s=64x64:r=10','-c:v','libx264','-pix_fmt','yuv420p'] : ['-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-c:a',format === 'mp3' ? 'libmp3lame' : 'aac'];
    execFileSync(mediaTools().ffmpeg, ['-nostdin','-v','error',...input,'-t','1',output], { windowsHide: true, timeout: 15000 });
    const response = await f.upload(readFileSync(output), `synthetic.${format}`); assert.equal(response.status, 201, JSON.stringify(response));
    assert.equal(response.value.validation.decoded, true); assert.ok(response.value.duration_seconds > 0 && response.value.duration_seconds < 2);
    assert.equal(response.value.content_type, format === 'mp4' ? 'video/mp4' : format === 'm4a' ? 'audio/mp4' : 'audio/mpeg');
  } finally { try { unlinkSync(output); rmdirSync(directory); } finally { await f.close(); } }
});

test('QuickTime content renamed to mp4 is rejected despite sharing the mov demuxer', { skip: !mediaValidationAvailable() }, async () => {
  const f = await fixture(), directory = mkdtempSync(join(tmpdir(), 'doogy-quicktime-fixture-')), output = join(directory, 'synthetic.mov');
  try {
    execFileSync(mediaTools().ffmpeg, ['-nostdin','-v','error','-f','lavfi','-i','color=c=green:s=64x64:r=10','-c:v','libx264','-t','1',output], { windowsHide: true, timeout: 15000 });
    const response = await f.upload(readFileSync(output), 'renamed.mp4');
    assert.equal(response.status, 415, JSON.stringify(response)); assert.equal(response.value.code, 'UNSUPPORTED_MEDIA_CODEC');
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM pet_media'))!.n, 0);
  } finally { try { unlinkSync(output); rmdirSync(directory); } finally { await f.close(); } }
});
