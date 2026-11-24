import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { test } from 'node:test';
import { AccountExportService } from '../src/account-export';
import { HealthObservationsService } from '../src/health-observations';
import { IdentityService } from '../src/identity';
import { ObservationsService } from '../src/observations';
import { CareService } from '../src/care';
import { PrivacyService } from '../src/privacy';
import { RetentionService } from '../src/retention';
import { Db, Row } from '../src/db';
import { openBackendFixture } from './backend-fixture';

const password = 'Synthetic-health-lifecycle-2026';
const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
async function fixture() {
  process.env.DATA_MODE = 'offline'; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-24T12:00:00.000Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db, identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `health-unit-${name}@example.invalid`, password, timezone: 'UTC' });
  const owner = await register('owner'), viewer = await register('viewer'), stranger = await register('stranger');
  const invitation = await identity.invite(owner.user.id, owner.household.id, { email: viewer.user.email, role: 'viewer' });
  await identity.accept(viewer.user.id, invitation.token);
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Health unit' });
  const otherPet = await identity.createPet(stranger.user.id, { household_id: stranger.household.id, name: 'Unrelated health unit' });
  const health = new HealthObservationsService(db), observations = new ObservationsService(db, new CareService(db));
  const assessment = await observations.get(owner.user.id, pet.id, { date: '2026-11-17', timezone: 'UTC' });
  const other = await observations.get(stranger.user.id, otherPet.id, { date: '2026-11-17', timezone: 'UTC' });
  return { ...backend, db, identity, owner, viewer, stranger, pet, otherPet, assessment, other, health, observations,
    privacy: new PrivacyService(db), retention: new RetentionService(db), exporter: new AccountExportService(db), advance: () => { now += 1000; } };
}

async function activitySamples(db: Db, pet: string) {
  const device = db.id(); let seq = 0;
  await db.run('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', device, `health-evidence-${device}`, 'fixture', 'fixture', 'unused', db.now());
  return async (start: string, end: string, metrics: Row) => {
    const event = db.id(), id = db.id(); seq++;
    await db.run(`INSERT INTO device_events(event_id,device_id,pet_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, event, device, pet, 'activity.reported', end, db.now(), seq, 'health-evidence', '{}', '{}', db.now());
    await db.run('INSERT INTO activity_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, event, device, pet, start, end,
      metrics.steps ?? null, metrics.active_seconds ?? null, null, metrics.sleep_seconds ?? null, metrics.estimated ?? 0, metrics.source ?? 'fixture-device', '{}');
    return id;
  };
}

test('activity evidence assigns source and estimation to each metric, excluding sleep-only inputs', async t => {
  const f = await fixture(); t.after(f.close); const span = await activitySamples(f.db, f.pet.id);
  for (const day of ['2026-11-11', '2026-11-13', '2026-11-15', '2026-11-17']) {
    const target = day === '2026-11-17';
    await span(`${day}T00:00:00.000Z`, `${day}T12:00:00.000Z`, { steps: target ? 500 : 1000, estimated: 0, source: 'step-meter-A' });
    const end = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString();
    await span(`${day}T12:00:00.000Z`, end, { active_seconds: target ? 600 : 1200, estimated: 1, source: 'activity-estimator-B' });
  }
  f.advance();
  const result = await f.observations.get(f.owner.user.id, f.pet.id, { date: '2026-11-17', timezone: 'UTC' });
  assert.deepEqual(result.observations.map((row: Row) => row.metric), ['steps', 'active_minutes']);
  const steps = result.evidence.find((row: Row) => row.metric === 'steps'), active = result.evidence.find((row: Row) => row.metric === 'active_minutes');
  assert.equal(steps.estimated, false); assert.deepEqual(steps.target.sources, ['step-meter-A']);
  assert.ok(steps.baseline.every((day: Row) => JSON.stringify(day.sources) === JSON.stringify(['step-meter-A'])));
  assert.equal(active.estimated, true); assert.deepEqual(active.target.sources, ['activity-estimator-B']);
  assert.ok(active.baseline.every((day: Row) => JSON.stringify(day.sources) === JSON.stringify(['activity-estimator-B'])));
  await span('2026-11-14T00:00:00.000Z', '2026-11-14T12:00:00.000Z', { sleep_seconds: 1800, estimated: 1, source: 'sleep-only-C' });
  f.advance();
  const unchanged = await f.observations.get(f.owner.user.id, f.pet.id, { date: '2026-11-17', timezone: 'UTC' });
  assert.equal(unchanged.id, result.id); assert.deepEqual(unchanged.evidence, result.evidence);
});

test('assessment revision order uses insertion order when generated times tie and UUID order disagrees', async t => {
  const f = await fixture(); t.after(f.close); const span = await activitySamples(f.db, f.pet.id);
  for (const day of ['2026-11-11', '2026-11-13', '2026-11-15']) await span(`${day}T00:00:00.000Z`, `${day}T12:00:00.000Z`, { steps: 1000 });
  const target = await span('2026-11-17T00:00:00.000Z', '2026-11-17T12:00:00.000Z', { steps: 500 });
  const originalId = f.db.id;
  try {
    f.db.id = () => 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const first = await f.observations.get(f.owner.user.id, f.pet.id, { date: '2026-11-17', timezone: 'UTC' });
    await f.health.markRead(f.owner.user.id, first.id);
    await f.db.run('UPDATE activity_samples SET steps=? WHERE id=?', 1000, target);
    f.db.id = () => '00000000-0000-4000-8000-000000000000';
    const second = await f.observations.get(f.owner.user.id, f.pet.id, { date: '2026-11-17', timezone: 'UTC' });
    assert.equal(first.id, 'ffffffff-ffff-4fff-8fff-ffffffffffff'); assert.equal(second.id, '00000000-0000-4000-8000-000000000000');
    assert.equal(first.generated_at, second.generated_at);
    const older = await f.health.detail(f.owner.user.id, first.id), newer = await f.health.detail(f.owner.user.id, second.id);
    assert.equal(older.superseded, true); assert.equal(newer.superseded, false); assert.equal(newer.read_at, null);
    assert.deepEqual(older.assessment.evidence, first.evidence);
    assert.equal((await f.observations.get(f.owner.user.id, f.pet.id, { date: '2026-11-17', timezone: 'UTC' })).id, second.id);
  } finally { f.db.id = originalId; }
});

test('health read receipts preserve first time under repeats, remain personal, and reject replay after revocation', async t => {
  const f = await fixture(); t.after(f.close);
  const first = await f.health.markRead(f.viewer.user.id, f.assessment.id, 'first-read'); f.advance();
  const repeated = await Promise.all([f.health.markRead(f.viewer.user.id, f.assessment.id), f.health.markRead(f.viewer.user.id, f.assessment.id, 'another-read')]);
  assert.ok(repeated.every(row => row.read_at === first.read_at));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM health_observation_reads WHERE user_id=?', f.viewer.user.id))!.n, 1);
  assert.equal((await f.health.detail(f.owner.user.id, f.assessment.id)).read_at, null);
  assert.equal((await f.health.detail(f.viewer.user.id, f.assessment.id)).read_at, first.read_at);
  await assert.rejects(f.health.markRead(f.stranger.user.id, f.assessment.id), status(404));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  await assert.rejects(f.health.markRead(f.viewer.user.id, f.assessment.id, 'first-read'), status(404));
  assert.deepEqual((await f.exporter.page(f.viewer.user.id, 'health_observation_reads', {})).items, []);
});

test('closing an account deletes its health read state while retaining other members and shared assessments', async t => {
  const f = await fixture(); t.after(f.close);
  await f.health.markRead(f.viewer.user.id, f.assessment.id, 'viewer-read');
  const ownerRead = await f.health.markRead(f.owner.user.id, f.assessment.id, 'owner-read');
  const exported = await f.exporter.page(f.viewer.user.id, 'health_observation_reads', {});
  assert.equal(exported.items.length, 1); assert.equal(exported.items[0].observation_id, f.assessment.id);
  assert.equal(exported.items[0].user_id, f.viewer.user.id);
  const closed = await f.privacy.closeAccount(f.viewer.user.id, { password, confirmation: 'DELETE' }); assert.equal(closed.closed, true);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM health_observation_reads WHERE user_id=?', f.viewer.user.id))!.n, 0);
  assert.equal((await f.health.detail(f.owner.user.id, f.assessment.id)).read_at, ownerRead.read_at);
  assert.ok(await f.db.get('SELECT id FROM activity_observations WHERE id=?', f.assessment.id));
});

test('pet deletion previews and cascades health reads without deleting another household history', async t => {
  const f = await fixture(); t.after(f.close);
  await f.health.markRead(f.owner.user.id, f.assessment.id, 'owner-read');
  await f.health.markRead(f.viewer.user.id, f.assessment.id, 'viewer-read');
  await f.health.markRead(f.stranger.user.id, f.other.id, 'stranger-read');
  const preview = await f.privacy.petPreview(f.owner.user.id, f.pet.id);
  assert.equal(preview.related_counts.health_observation_reads, 2);
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM health_observation_reads WHERE observation_id=?', f.assessment.id))!.n, 0);
  await assert.rejects(f.health.detail(f.owner.user.id, f.assessment.id), status(404));
  assert.ok((await f.health.detail(f.stranger.user.id, f.other.id)).read_at);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_json LIKE ?', `%${f.assessment.id}%`))!.n, 0);
});

test('activity retention previews and removes dependent health reads and replay receipts, including former members', async t => {
  const f = await fixture(); t.after(f.close);
  const device = f.db.id(), event = f.db.id();
  await f.db.run('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', device, 'health-retention', 'fixture', 'fixture', 'unused', f.db.now());
  await f.db.run(`INSERT INTO device_events(event_id,device_id,pet_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, event, device, f.pet.id, 'activity.reported', '2026-11-17T12:00:00.000Z', f.db.now(), 1, 'health-retention', '{}', '{}', f.db.now());
  await f.db.run('INSERT INTO activity_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', f.db.id(), event, device, f.pet.id,
    '2026-11-17T00:00:00.000Z', '2026-11-17T12:00:00.000Z', 500, null, null, null, 0, 'fixture-device', '{}');
  await f.health.markRead(f.owner.user.id, f.assessment.id, 'retention-owner-read');
  await f.health.markRead(f.viewer.user.id, f.assessment.id, 'retention-viewer-read');
  await f.health.markRead(f.stranger.user.id, f.other.id, 'unrelated-read');
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  await f.retention.update(f.owner.user.id, f.owner.household.id, { password, enabled: true, telemetry_days: 1, activity_days: 1, safety_days: 1 });
  const preview = await f.retention.preview(f.owner.user.id, f.owner.household.id);
  assert.equal(preview.households[0].related_counts.health_observation_reads, 2);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM health_observation_reads WHERE observation_id=?', f.assessment.id))!.n, 2);
  await f.retention.execute(f.owner.user.id, f.owner.household.id, { password });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM health_observation_reads WHERE observation_id=?', f.assessment.id))!.n, 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_json LIKE ?', `%${f.assessment.id}%`))!.n, 0);
  await assert.rejects(f.health.detail(f.owner.user.id, f.assessment.id), status(404));
  assert.ok((await f.health.detail(f.stranger.user.id, f.other.id)).read_at);
});
