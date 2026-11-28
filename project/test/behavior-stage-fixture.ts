import { createHash } from 'node:crypto';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { BehaviorService } from '../src/behavior';
import { openBackendFixture } from './backend-fixture';

export async function seedBehaviorMedia(db: Db, pet: string, user: string) {
  const id = db.id(), bytes = Buffer.from('isolated behavior metadata fixture');
  await db.run(`INSERT INTO pet_media(id,pet_id,filename,content_type,size_bytes,sha256,content_base64,duration_seconds,captured_at,source,created_by,created_at,validation_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, pet, 'metadata-fixture.wav', 'audio/wav', bytes.length, createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'),
    60, '2026-11-24T11:58:00.000Z', 'synthetic', user, db.now(), JSON.stringify({ scope: 'task_reference_fixture_only', media_validation_performed: false }));
  return id;
}
export async function behaviorFixture(mode: 'offline' | 'api' = 'offline') {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-24T12:00:00.000Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db, identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `behavior-${name}@example.invalid`, password: 'Synthetic-behavior-2026', timezone: 'UTC' });
  const owner = await register('owner'), caregiver = await register('caregiver'), viewer = await register('viewer'), stranger = await register('stranger');
  for (const [user, role] of [[caregiver, 'caregiver'], [viewer, 'viewer']] as const) {
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: user.user.email, role });
    await identity.accept(user.user.id, invitation.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Behavior fixture' });
  const otherPet = await identity.createPet(stranger.user.id, { household_id: stranger.household.id, name: 'Unrelated behavior fixture' });
  const media = await seedBehaviorMedia(db, pet.id, owner.user.id), otherMedia = await seedBehaviorMedia(db, otherPet.id, stranger.user.id);
  return { ...backend, db, identity, owner, caregiver, viewer, stranger, pet, otherPet, media, otherMedia,
    service: new BehaviorService(db), advance: () => { now += 1000; } };
}
