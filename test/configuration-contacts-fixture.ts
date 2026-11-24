import { Db } from '../src/db';
import { FencesService } from '../src/fences';
import { ContactsService } from '../src/contacts';

export const configurationContactTables = ['pet_configuration_history','household_contacts'];

export async function seedConfigurationContacts(db: Db, user: string, pet: string, household: string) {
  const fences = new FencesService(db), contacts = new ContactsService(db);
  const fence = await fences.create(user, { pet_id: pet, name: 'Synthetic history safe area', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
  await fences.update(user, fence.id, { buffer_m: 40 });
  const created = await contacts.create(user, household, { name: 'Synthetic family contact', phone: '+86 13800000000', purpose: 'Synthetic metadata only',
    is_primary: true, consent: { status: 'reported_granted', note: 'Reported fixture; no verified recipient or actual delivery' } });
  const contact = await contacts.update(user, created.id, { expected_version: 1, purpose: 'Updated synthetic metadata only' });
  const history = await db.all('SELECT * FROM pet_configuration_history WHERE resource_id=? ORDER BY version', fence.id);
  return { contact, fence, history };
}
