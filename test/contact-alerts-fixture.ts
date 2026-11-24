import { ContactAlertsService } from '../src/contact-alerts';
import { ContactsService } from '../src/contacts';
import { IdentityService } from '../src/identity';
import { Row } from '../src/db';
import { openBackendFixture } from './backend-fixture';

export async function contactAlertFixture(mode: 'offline' | 'api' = 'offline') {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-24T12:00:00.000Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db, identity = new IdentityService(db), contacts = new ContactsService(db);
  const register = (name: string) => identity.register({ email: `contact-alert-${name}@example.invalid`, password: 'Synthetic-contact-alert-2026', timezone: 'UTC' });
  const owner = await register('owner'), caregiver = await register('caregiver'), viewer = await register('viewer'), stranger = await register('stranger');
  for (const [user, role] of [[caregiver, 'caregiver'], [viewer, 'viewer']] as const) {
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: user.user.email, role }); await identity.accept(user.user.id, invitation.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Contact alert fixture' });
  const otherPet = await identity.createPet(stranger.user.id, { household_id: stranger.household.id, name: 'Other contact alert fixture' });
  const granted = await contacts.create(owner.user.id, owner.household.id, { name: 'Reported recipient', email: 'synthetic-destination@example.invalid', consent: { status: 'reported_granted' } });
  const unknown = await contacts.create(owner.user.id, owner.household.id, { name: 'Unknown consent recipient', phone: '+86 13800000000' });
  const other = await contacts.create(stranger.user.id, stranger.household.id, { name: 'Other household recipient', email: 'other-destination@example.invalid', consent: { status: 'reported_granted' } });
  return { ...backend, db, identity, contacts, owner, caregiver, viewer, stranger, pet, otherPet, granted, unknown, other,
    service: new ContactAlertsService(db), advance: (ms = 1000) => { now += ms; } };
}
export const selectedContact = (contact: Row, method: 'email' | 'phone' = 'email') => ({ contact_id: contact.id, expected_version: contact.version, method });
export const contactAlertBody = (recipients: ReturnType<typeof selectedContact>[], extra: Record<string, unknown> = {}) => ({
  message: '  Please check the pet. This is a local test.  ', consent: true, recipients, ...extra,
});
