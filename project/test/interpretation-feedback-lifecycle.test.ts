import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { BehaviorService } from '../src/behavior';
import { CareService } from '../src/care';
import { MediaService } from '../src/media';
import { AccountExportService } from '../src/account-export';
import { PrivacyService } from '../src/privacy';
import { RetentionService } from '../src/retention';
import { DevicesService, provisionDevice } from '../src/devices';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';
import { snapshotDatabase } from '../scripts/database-snapshot';
import { openBackendFixture } from './backend-fixture';
import { insertSyntheticMedia } from './media-fixture';

const password = 'Synthetic-feedback-lifecycle-2026', day = 86400000;
const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;

async function seed(db: Db) {
  process.env.DATA_MODE = 'offline';
  const identity = new IdentityService(db), service = new BehaviorService(db), care = new CareService(db);
  const register = (name: string) => identity.register({ email: `feedback-lifecycle-${name}@example.invalid`, password, timezone: 'UTC' });
  const owner = await register('owner'), caregiver = await register('caregiver'), viewer = await register('viewer'), outsider = await register('outsider');
  for (const [user, role] of [[caregiver, 'caregiver'], [viewer, 'viewer']] as const) {
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: user.user.email, role });
    await identity.accept(user.user.id, invitation.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Interpretation feedback fixture' });
  const otherPet = await identity.createPet(outsider.user.id, { household_id: outsider.household.id, name: 'Unrelated feedback fixture' });
  const firstMedia = await insertSyntheticMedia(db, pet.id, owner.user.id), secondMedia = await insertSyntheticMedia(db, pet.id, owner.user.id);
  const complete = async (media: string, user = owner.user.id) => {
    const task = await service.createInterpretation(user, pet.id, { media_id: media });
    await service.work();
    const saved = await service.interpretation(user, task.id); assert.equal(saved.status, 'succeeded');
    return saved;
  };
  return { db, identity, service, care, owner, caregiver, viewer, outsider, pet, otherPet, firstMedia, secondMedia, complete,
    exporter: new AccountExportService(db), privacy: new PrivacyService(db), media: new MediaService(db), retention: new RetentionService(db) };
}
async function fixture() {
  let time = Date.parse('2026-11-24T12:00:00Z');
  const backend = await openBackendFixture(() => new Date(time));
  return { ...await seed(backend.db), close: backend.close, advance: (ms: number) => { time += ms; } };
}
function feedbackBody(comment = 'Keep this user-authored comment') {
  return { expected_attempt: 1, assessment: 'helpful', comment };
}
async function evidence(db: Db, id: string): Promise<Row> {
  const row = (await db.get('SELECT * FROM behavior_feedback WHERE id=?', id))!;
  return { ...row, evidence: JSON.parse(row.evidence_json) };
}
async function feedbackCache(db: Db, user: string, task: string, key: string) {
  return db.get('SELECT * FROM idempotency_keys WHERE user_id=? AND scope=? AND key=?', user, `POST /interpretations/${task}/feedback`, key);
}

test('解释反馈仅本人导出且要求当前家庭权限；撤权后的旧反馈键不能扩大访问', async t => {
  const f = await fixture(); t.after(f.close);
  const task = await f.complete(f.firstMedia.id);
  const own = await f.service.feedback(f.owner.user.id, task.id, feedbackBody('Owner feedback'), 'owner-feedback');
  const helper = await f.service.feedback(f.caregiver.user.id, task.id, feedbackBody('Caregiver feedback'), 'helper-feedback');
  const ownerPage = await f.exporter.page(f.owner.user.id, 'feedback', {});
  assert.deepEqual(ownerPage.items.map((row: Row) => row.id), [own.id]);
  assert.equal(ownerPage.items[0].evidence.source, 'interpretation');
  assert.equal(ownerPage.items[0].evidence.interpretation_id, task.id); assert.equal(ownerPage.items[0].evidence.attempt, 1);
  assert.equal(ownerPage.items[0].evidence.evidence_id, task.evidence.id); assert.equal(ownerPage.items[0].evidence.media_id, f.firstMedia.id);
  assert.equal((await f.exporter.page(f.caregiver.user.id, 'feedback', {})).items[0].id, helper.id);
  assert.equal((await f.exporter.page(f.viewer.user.id, 'feedback', {})).items.length, 0);
  assert.equal((await f.exporter.page(f.outsider.user.id, 'feedback', {})).items.length, 0);
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id);
  assert.equal((await f.exporter.page(f.caregiver.user.id, 'feedback', {})).items.length, 0);
  await assert.rejects(f.service.feedback(f.caregiver.user.id, task.id, feedbackBody('Caregiver feedback'), 'helper-feedback'), status(404));
  assert.equal((await evidence(f.db, helper.id)).comment, 'Caregiver feedback');
  await f.media.delete(f.owner.user.id, f.firstMedia.id);
  assert.equal(await feedbackCache(f.db, f.caregiver.user.id, task.id, 'helper-feedback'), undefined, 'source deletion must also purge a former member receipt');
  const invitation = await f.identity.invite(f.owner.user.id, f.owner.household.id, { email: f.caregiver.user.email, role: 'viewer' });
  await f.identity.accept(f.caregiver.user.id, invitation.token);
  const restoredAccess = (await f.exporter.page(f.caregiver.user.id, 'feedback', {})).items[0];
  assert.equal(restoredAccess.id, helper.id); assert.equal(restoredAccess.comment, 'Caregiver feedback'); assert.deepEqual(restoredAccess.evidence, {});
});

test('删除媒体清解释反馈证据与各用户仅ID回执，保留评论、无关媒体反馈及普通旧反馈', async t => {
  const f = await fixture(); t.after(f.close);
  const task = await f.complete(f.firstMedia.id), otherTask = await f.complete(f.secondMedia.id);
  const own = await f.service.feedback(f.owner.user.id, task.id, feedbackBody(), 'owner-feedback');
  const helper = await f.service.feedback(f.caregiver.user.id, task.id, feedbackBody('Retain caregiver comment'), 'helper-feedback');
  const unrelated = await f.service.feedback(f.owner.user.id, otherTask.id, feedbackBody('Unrelated media comment'), 'other-feedback');
  const legacy = await f.care.feedback(f.owner.user.id, f.pet.id, { feature_date: '2026-11-24', assessment: 'other', comment: 'Legacy feedback unaffected', evidence: { source: 'legacy_owner_note', context: 'unrelated manual note' } });
  const originalOther = (await evidence(f.db, unrelated.id)).evidence, originalLegacy = (await evidence(f.db, legacy.id)).evidence;
  assert.ok(await feedbackCache(f.db, f.owner.user.id, task.id, 'owner-feedback'));
  assert.ok(await feedbackCache(f.db, f.caregiver.user.id, task.id, 'helper-feedback'));
  const deleted = await f.media.delete(f.owner.user.id, f.firstMedia.id); assert.equal(deleted.affected.feedback_evidence, 2);
  for (const row of [own, helper]) {
    const retained = await evidence(f.db, row.id); assert.deepEqual(retained.evidence, {}); assert.equal(retained.comment, row.comment); assert.equal(retained.assessment, row.assessment);
  }
  assert.equal(await feedbackCache(f.db, f.owner.user.id, task.id, 'owner-feedback'), undefined);
  assert.equal(await feedbackCache(f.db, f.caregiver.user.id, task.id, 'helper-feedback'), undefined);
  assert.ok(await feedbackCache(f.db, f.owner.user.id, otherTask.id, 'other-feedback'));
  assert.deepEqual((await evidence(f.db, unrelated.id)).evidence, originalOther); assert.deepEqual((await evidence(f.db, legacy.id)).evidence, originalLegacy);
  await assert.rejects(f.service.feedback(f.owner.user.id, task.id, feedbackBody(), 'owner-feedback'), status(409));
  const exported = await f.exporter.page(f.owner.user.id, 'feedback', {});
  assert.deepEqual(exported.items.find((row: Row) => row.id === own.id).evidence, {});
});

test('活动到期预览与执行清除引用解释的反馈证据和缓存，保留评论与其他家庭', async t => {
  const f = await fixture(); t.after(f.close);
  const devices = new DevicesService(f.db), device = await provisionDevice(f.db, { serial_no: 'FEEDBACK-RETENTION-DEVICE' });
  await devices.claim(f.owner.user.id, { ...device, pet_id: f.pet.id });
  const telemetry = new TelemetryService(f.db, devices, new NotificationService(f.db));
  await telemetry.ingest({ schema_version: '1.0', event_id: 'feedback-retention-activity', device_id: device.device_id, event_type: 'activity.reported',
    device_ts: f.db.now(), boot_id: 'feedback-retention-boot', seq: 1,
    payload: { start_at: '2026-11-24T11:00:00Z', end_at: f.db.now(), steps: 120, active_seconds: 60, source: 'synthetic' } }, device.device_token);
  await telemetry.work();
  const task = await f.complete(f.firstMedia.id); assert.equal(task.evidence.activity.sample_count, 1);
  const feedback = await f.service.feedback(f.owner.user.id, task.id, feedbackBody('Retain after activity expiry'), 'retention-feedback');
  const unrelated = await f.care.feedback(f.outsider.user.id, f.otherPet.id, { feature_date: '2026-11-24', assessment: 'other', comment: 'Other household', evidence: { source: 'unrelated_household' } });
  f.advance(8 * day);
  await f.db.run('UPDATE idempotency_keys SET created_at=? WHERE user_id=? AND scope=? AND key=?', f.db.now(), f.owner.user.id, `POST /interpretations/${task.id}/feedback`, 'retention-feedback');
  await f.retention.update(f.owner.user.id, f.owner.household.id, { enabled: true, telemetry_days: 2, activity_days: 7, safety_days: 7, password });
  const before = await evidence(f.db, feedback.id), preview = await f.retention.preview(f.owner.user.id, f.owner.household.id);
  assert.equal(preview.households[0].related_counts.interpretation_feedback_evidence_invalidated, 1);
  assert.deepEqual((await evidence(f.db, feedback.id)).evidence, before.evidence, 'preview must not erase evidence');
  await f.retention.execute(f.owner.user.id, f.owner.household.id, { password });
  const retained = await evidence(f.db, feedback.id); assert.deepEqual(retained.evidence, {}); assert.equal(retained.comment, 'Retain after activity expiry');
  assert.equal(await feedbackCache(f.db, f.owner.user.id, task.id, 'retention-feedback'), undefined);
  assert.deepEqual((await evidence(f.db, unrelated.id)).evidence, { source: 'unrelated_household' });
});

test('注销删除本人解释反馈，删除宠物清共享反馈且不影响其他家庭', async t => {
  const f = await fixture(); t.after(f.close);
  const task = await f.complete(f.firstMedia.id);
  const own = await f.service.feedback(f.owner.user.id, task.id, feedbackBody('Owner retained until pet deletion'), 'owner-feedback');
  const helper = await f.service.feedback(f.caregiver.user.id, task.id, feedbackBody('Close this author'), 'helper-feedback');
  const unrelated = await f.care.feedback(f.outsider.user.id, f.otherPet.id, { feature_date: '2026-11-24', assessment: 'other', comment: 'Other household preserved', evidence: {} });
  await f.privacy.closeAccount(f.caregiver.user.id, { password, confirmation: 'DELETE' });
  assert.equal(await f.db.get('SELECT id FROM behavior_feedback WHERE id=?', helper.id), undefined);
  assert.equal(await feedbackCache(f.db, f.caregiver.user.id, task.id, 'helper-feedback'), undefined);
  assert.ok(await f.db.get('SELECT id FROM behavior_feedback WHERE id=?', own.id));
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM behavior_feedback WHERE pet_id=?', f.pet.id))!.n, 0);
  assert.equal(await feedbackCache(f.db, f.owner.user.id, task.id, 'owner-feedback'), undefined);
  assert.ok(await f.db.get('SELECT id FROM behavior_feedback WHERE id=?', unrelated.id));
});

test('真实SQLite备份恢复后重放媒体删除日志，反馈正文评论保留而证据与旧回执不可复活', async () => {
  process.env.DATA_MODE = 'offline';
  const folder = mkdtempSync(resolve(tmpdir(), 'doogy-feedback-backup-'));
  const source = resolve(folder, 'source.db'), snapshot = resolve(folder, 'snapshot.db'), restored = resolve(folder, 'restored.db');
  const db = new Db(source, () => new Date('2026-11-24T12:00:00Z'));
  let recovered: Db | undefined;
  try {
    const f = await seed(db);
    const task = await f.complete(f.firstMedia.id), otherTask = await f.complete(f.secondMedia.id);
    const saved = await f.service.feedback(f.owner.user.id, task.id, feedbackBody('Preserve this comment across restore'), 'backup-feedback');
    const other = await f.service.feedback(f.owner.user.id, otherTask.id, feedbackBody('Other media survives restore'), 'backup-other');
    const originalOther = (await evidence(db, other.id)).evidence;
    await db.exec('PRAGMA wal_autocheckpoint=0');
    assert.equal((await snapshotDatabase(source, snapshot)).integrity, 'ok');
    const archiveHash = createHash('sha256').update(readFileSync(snapshot)).digest('hex');
    await f.media.delete(f.owner.user.id, f.firstMedia.id);
    const receipts = await f.privacy.receipts(); assert.ok(receipts.some(row => row.kind === 'pet_media' && row.resource_id === f.firstMedia.id));
    await snapshotDatabase(snapshot, restored);
    recovered = new Db(restored, () => new Date('2026-11-24T12:00:00Z'));
    assert.ok(await recovered.get('SELECT id FROM pet_media WHERE id=?', f.firstMedia.id));
    assert.notDeepEqual((await evidence(recovered, saved.id)).evidence, {}, 'backup must contain the pre-deletion evidence');
    assert.ok(await feedbackCache(recovered, f.owner.user.id, task.id, 'backup-feedback'));
    const privacy = new PrivacyService(recovered);
    assert.equal((await privacy.replay(receipts)).applied, receipts.length);
    assert.equal(await recovered.get('SELECT id FROM pet_media WHERE id=?', f.firstMedia.id), undefined);
    const row = await evidence(recovered, saved.id); assert.equal(row.comment, 'Preserve this comment across restore'); assert.deepEqual(row.evidence, {});
    assert.equal(await feedbackCache(recovered, f.owner.user.id, task.id, 'backup-feedback'), undefined);
    assert.deepEqual((await evidence(recovered, other.id)).evidence, originalOther);
    assert.ok(await feedbackCache(recovered, f.owner.user.id, otherTask.id, 'backup-other'));
    const invalid = await new BehaviorService(recovered).interpretation(f.owner.user.id, task.id); assert.equal(invalid.result, null); assert.equal(invalid.error_code, 'MEDIA_SOURCE_DELETED');
    assert.equal((await privacy.replay(receipts)).applied, 0);
    assert.equal(createHash('sha256').update(readFileSync(snapshot)).digest('hex'), archiveHash);
  } finally {
    if (recovered) await recovered.close(); await db.close();
    for (const file of [source, snapshot, restored]) for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(file + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    rmdirSync(folder);
  }
});
