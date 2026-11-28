import { ConfigurationHistoryService } from '../src/configuration-history';
import { DevicesService, provisionDevice } from '../src/devices';
import { FencesService } from '../src/fences';
import { IdentityService } from '../src/identity';
import { ReportingService } from '../src/reporting';
import { openBackendFixture } from './backend-fixture';

export async function configurationFixture(mode: 'offline' | 'api' = 'offline') {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-24T12:00:00.000Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db, identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `configuration-${name}@example.invalid`, password: 'Synthetic-configuration-2026', timezone: 'UTC' });
  const owner = await register('owner'), caregiver = await register('caregiver'), viewer = await register('viewer'), stranger = await register('stranger');
  for (const [user, role] of [[caregiver, 'caregiver'], [viewer, 'viewer']] as const) {
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: user.user.email, role });
    await identity.accept(user.user.id, invitation.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Configuration pet' });
  const otherPet = await identity.createPet(stranger.user.id, { household_id: stranger.household.id, name: 'Unrelated configuration pet' });
  const device = await provisionDevice(db, { serial_no: 'configuration-fixture' }), devices = new DevicesService(db);
  await devices.claim(owner.user.id, { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
  return { ...backend, db, identity, owner, caregiver, viewer, stranger, pet, otherPet, device, devices,
    fences: new FencesService(db), reporting: new ReportingService(db), history: new ConfigurationHistoryService(db), advance: (ms = 1000) => { now += ms; } };
}
export const configurationRange = { from: '2026-11-24T11:59:59Z', to: '2026-11-25T00:00:00Z' };
export const fenceInput = (pet: string) => ({ pet_id: pet, name: 'Home', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
