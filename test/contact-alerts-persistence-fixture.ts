import { strict as assert } from 'node:assert';
import { Db, Row } from '../src/db';
import { ContactsService } from '../src/contacts';
import { ContactAlertsService } from '../src/contact-alerts';
import { AccountExportService } from '../src/account-export';

export async function seedContactAlerts(db: Db, user: string, pet: string, household: string) {
  const contacts = new ContactsService(db), alerts = new ContactAlertsService(db);
  const allowed = await contacts.create(user, household, { name: 'Synthetic alert consented contact', email: 'alert-consented@example.invalid',
    consent: { status: 'reported_granted', note: 'Synthetic household report; no verified consent or real delivery' } });
  const unknown = await contacts.create(user, household, { name: 'Synthetic alert unknown contact', phone: '+86 13900000000' });
  const input = { message: 'Synthetic message-only alert; no location or share link.', consent: true,
    recipients: [{ contact_id: allowed.id, expected_version: allowed.version, method: 'email' }, { contact_id: unknown.id, expected_version: unknown.version, method: 'phone' }] };
  const queued = await alerts.create(user, pet, input, 'preserved-contact-alert');
  assert.equal(queued.status, 'pending'); assert.equal(await alerts.work(), 1);
  const completed = await alerts.get(user, queued.id);
  assert.equal(completed.status, 'partial'); assert.equal(completed.content_scope, 'message_only'); assert.equal(completed.location_link_included, false);
  assert.deepEqual(completed.counts, { total: 2, pending: 0, simulated: 1, failed: 1, cancelled: 0 });
  const simulated = completed.recipients.find((row: Row) => row.contact_id === allowed.id)!;
  const failed = completed.recipients.find((row: Row) => row.contact_id === unknown.id)!;
  assert.equal(simulated.status, 'simulated'); assert.equal(simulated.execution_source, 'offline_demo'); assert.equal(simulated.consent_verified, false);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error_code, 'RECIPIENT_CONSENT_REQUIRED');
  assert.equal((await alerts.create(user, pet, input, 'preserved-contact-alert')).id, completed.id);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM contact_alerts WHERE pet_id=?', pet))!.n, 1);
  return { id: completed.id, user, pet, household, allowed: allowed.id, unknown: unknown.id };
}

export async function assertContactAlertsPreserved(source: Db, recovered: Db, expected: Awaited<ReturnType<typeof seedContactAlerts>>) {
  const before = (await source.get('SELECT * FROM contact_alerts WHERE id=?', expected.id))!;
  const after = (await recovered.get('SELECT * FROM contact_alerts WHERE id=?', expected.id))!;
  assert.ok(before); assert.ok(after); assert.deepEqual({ ...after }, { ...before });
  const original = await source.all('SELECT * FROM contact_alert_recipients WHERE alert_id=? ORDER BY id', expected.id);
  const recipients = await recovered.all('SELECT * FROM contact_alert_recipients WHERE alert_id=? ORDER BY id', expected.id);
  assert.deepEqual(recipients.map(row => ({ ...row })), original.map(row => ({ ...row }))); assert.equal(recipients.length, 2);
  assert.deepEqual(await new ContactAlertsService(recovered).get(expected.user, expected.id), await new ContactAlertsService(source).get(expected.user, expected.id));
  const exporter = new AccountExportService(recovered), manifest = await exporter.manifest(expected.user);
  const household = manifest.households.find((row: Row) => row.id === expected.household)!;
  assert.ok(household.sections.includes('contact_alerts')); assert.ok(household.sections.includes('contact_alert_recipients'));
  const exported = await exporter.page(expected.user, 'contact_alerts', { household_id: expected.household });
  assert.equal(exported.items.filter((row: Row) => row.id === expected.id).length, 1);
  assert.deepEqual(exported.items.find((row: Row) => row.id === expected.id), { ...after });
  const exportedRecipients = await exporter.page(expected.user, 'contact_alert_recipients', { household_id: expected.household });
  assert.deepEqual(exportedRecipients.items.filter((row: Row) => row.alert_id === expected.id).sort((a: Row, b: Row) => a.id.localeCompare(b.id)),
    recipients.map(row => ({ ...row })).sort((a, b) => a.id.localeCompare(b.id)));
  for (const row of [...recipients, ...exportedRecipients.items]) for (const key of ['phone','email','address','token','url']) assert.equal(Object.hasOwn(row, key), false);
}
