import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { test } from 'node:test';
import { contactAlertFixture, contactAlertBody, selectedContact } from './contact-alerts-fixture';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;

test('explicit selected recipients require contact versions and methods, while receipts and tables hold no address or location link copies', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  const recipients = [selectedContact(f.granted), selectedContact(f.unknown, 'phone')], input = contactAlertBody(recipients);
  for (const extra of [{ recipients: [] }, { recipients: [recipients[0], recipients[0]] }, { consent: false }, { message: ' ' }, { message: 'x'.repeat(1001) },
    { share_id: f.db.id() }, { token: 'not-accepted' }, { phone: 'not-accepted' }]) await assert.rejects(f.service.create(f.owner.user.id, f.pet.id, { ...input, ...extra }));
  await assert.rejects(f.service.create(f.viewer.user.id, f.pet.id, input), status(403));
  await assert.rejects(f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.other)])), status(404));
  await assert.rejects(f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([{ ...recipients[0], expected_version: 99 }])), status(409));
  await assert.rejects(f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted, 'phone')])), status(409));
  const values = await Promise.all([f.service.create(f.owner.user.id, f.pet.id, input, 'request-once'),
    f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([...recipients].reverse()), 'request-once')]);
  assert.equal(values[0].id, values[1].id); assert.equal(values[0].message, input.message.trim()); assert.equal(values[0].status, 'pending');
  assert.deepEqual(values[0].counts, { total: 2, pending: 2, simulated: 0, failed: 0, cancelled: 0 });
  assert.equal(values[0].content_scope, 'message_only'); assert.equal(values[0].location_link_included, false); assert.equal(values[0].recipient_consent_verified, false);
  assert.ok(values[0].recipients.every((row: any) => !row.consent_verified && row.consent_source === 'household_member_reported'));
  const cache = (await f.db.get('SELECT request_json,response_json FROM idempotency_keys WHERE key=?', 'request-once'))!;
  assert.deepEqual(JSON.parse(cache.response_json), { id: values[0].id });
  const stored = JSON.stringify({ parents: await f.db.all('SELECT * FROM contact_alerts'), recipients: await f.db.all('SELECT * FROM contact_alert_recipients'), cache });
  assert.equal(stored.includes(f.granted.email), false); assert.equal(stored.includes(f.unknown.phone), false); assert.equal(stored.includes('public_path'), false);
  assert.equal((await f.service.get(f.viewer.user.id, values[0].id)).id, values[0].id);
  await assert.rejects(f.service.get(f.stranger.user.id, values[0].id), status(404));
});

test('worker handles each recipient once, marks reported consent as unverified and never treats missing configuration as a send', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  const alert = await f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted), selectedContact(f.unknown, 'phone')]));
  assert.equal(await f.service.work(), 1); assert.equal(await f.service.work(), 0);
  const result = await f.service.get(f.owner.user.id, alert.id);
  assert.equal(result.status, 'partial'); assert.deepEqual(result.counts, { total: 2, pending: 0, simulated: 1, failed: 1, cancelled: 0 });
  assert.equal(result.recipients.find((row: any) => row.contact_id === f.granted.id).execution_source, 'offline_demo');
  assert.equal(result.recipients.find((row: any) => row.contact_id === f.unknown.id).error_code, 'RECIPIENT_CONSENT_REQUIRED');
  const updated = result.updated_at; f.advance(); await f.service.expire();
  assert.equal((await f.service.get(f.owner.user.id, alert.id)).updated_at, updated);
  await assert.rejects(f.service.retry(f.owner.user.id, alert.id, { expected_attempt: 1 }), status(409));
  process.env.DATA_MODE = 'api';
  const api = await f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted)])); await f.service.work();
  const failed = await f.service.get(f.owner.user.id, api.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.recipients[0].error_code, 'CHANNEL_NOT_CONFIGURED'); assert.equal(failed.recipients[0].execution_source, null);
});

test('same-ID retry preserves recipient IDs and original author, changes the current requester and cannot be reset by stale requests', async t => {
  const f = await contactAlertFixture('api'); t.after(f.close);
  const input = contactAlertBody([selectedContact(f.granted)]), alert = await f.service.create(f.owner.user.id, f.pet.id, input); await f.service.work();
  const failed = await f.service.get(f.owner.user.id, alert.id), expires = failed.expires_at;
  process.env.DATA_MODE = 'offline';
  const pending = await f.service.retry(f.caregiver.user.id, alert.id, { expected_attempt: 1 }, 'retry-once');
  assert.equal(pending.id, alert.id); assert.equal(pending.attempt, 2); assert.equal(pending.created_by, f.owner.user.id); assert.equal(pending.requested_by, f.caregiver.user.id);
  assert.equal(pending.expires_at, expires); assert.equal(pending.recipients[0].id, failed.recipients[0].id); assert.equal(pending.recipients[0].attempt, 2);
  await assert.rejects(f.service.retry(f.owner.user.id, alert.id, { expected_attempt: 1 }), status(409));
  await f.service.work(); const complete = await f.service.get(f.owner.user.id, alert.id); assert.equal(complete.status, 'simulated');
  assert.equal((await f.service.retry(f.caregiver.user.id, alert.id, { expected_attempt: 1 }, 'retry-once')).status, 'simulated');
  assert.equal((await f.service.get(f.owner.user.id, alert.id)).attempt, 2);
  await assert.rejects(f.service.retry(f.owner.user.id, alert.id, { expected_attempt: 2 }), status(409));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id);
  await assert.rejects(f.service.retry(f.caregiver.user.id, alert.id, { expected_attempt: 1 }, 'retry-once'), status(404));
});

test('contact changes and deletion invalidate queued selections without rewriting past simulated or cancelled outcomes', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  const second = await f.contacts.create(f.owner.user.id, f.owner.household.id, { name: 'Another granted recipient', phone: '+1 2025550100', consent: { status: 'reported_granted' } });
  const alert = await f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted), selectedContact(second, 'phone')]));
  await f.contacts.update(f.owner.user.id, f.granted.id, { expected_version: f.granted.version, name: 'Updated contact' });
  const changed = await f.service.get(f.owner.user.id, alert.id); assert.equal(changed.counts.failed, 1); assert.equal(changed.counts.pending, 1);
  assert.equal(changed.recipients.find((row: any) => row.contact_id === f.granted.id).error_code, 'CONTACT_CHANGED');
  const cancelled = await f.service.cancel(f.owner.user.id, alert.id, { expected_attempt: 1 }, 'cancel-pending');
  assert.equal(cancelled.counts.cancelled, 1); assert.equal(cancelled.counts.failed, 1);
  await assert.rejects(f.service.retry(f.owner.user.id, alert.id, { expected_attempt: 1 }), status(409));
  await f.db.run('UPDATE household_contacts SET version=? WHERE id=?', f.granted.version, f.granted.id);
  await assert.rejects(f.service.retry(f.owner.user.id, alert.id, { expected_attempt: 1 }), status(409));
  const history = await f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(second, 'phone')])); await f.service.work();
  const simulated = await f.service.get(f.owner.user.id, history.id); assert.equal(simulated.status, 'simulated');
  const processed = simulated.recipients[0].processed_at;
  await f.contacts.delete(f.owner.user.id, second.id, { expected_version: second.version });
  const retained = await f.service.get(f.owner.user.id, history.id);
  assert.equal(retained.status, 'simulated'); assert.equal(retained.recipients[0].contact_id, null); assert.equal(retained.recipients[0].processed_at, processed);
  assert.equal((await f.service.get(f.owner.user.id, alert.id)).recipients.find((row: any) => row.id === cancelled.recipients.find((r: any) => r.status === 'cancelled').id).status, 'cancelled');
});

test('expiry commits pending failures without extending or recreating the request, and mode/access changes stop workers', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  const input = contactAlertBody([selectedContact(f.granted)], { expires_in_seconds: 60 });
  const alert = await f.service.create(f.owner.user.id, f.pet.id, input, 'expires-once'); f.advance(61000);
  await assert.rejects(f.service.retry(f.owner.user.id, alert.id, { expected_attempt: 1 }), status(409));
  assert.equal((await f.db.get('SELECT status FROM contact_alert_recipients WHERE alert_id=?', alert.id))!.status, 'failed');
  const expired = await f.service.create(f.owner.user.id, f.pet.id, input, 'expires-once');
  assert.equal(expired.id, alert.id); assert.equal(expired.expires_at, alert.expires_at); assert.equal(expired.recipients[0].error_code, 'REQUEST_EXPIRED');
  const last = expired.updated_at; f.advance(); assert.equal((await f.service.expire()).expired_recipients, 0);
  assert.equal((await f.service.get(f.owner.user.id, alert.id)).updated_at, last);
  const mode = await f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted)]));
  process.env.DATA_MODE = 'api'; await f.service.work(); process.env.DATA_MODE = 'offline';
  assert.equal((await f.service.get(f.owner.user.id, mode.id)).recipients[0].error_code, 'DATA_MODE_CHANGED');
  const revoked = await f.service.create(f.caregiver.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted)]));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id); await f.service.work();
  assert.equal((await f.service.get(f.owner.user.id, revoked.id)).recipients[0].error_code, 'ACCESS_REVOKED');
  const retry = await f.service.retry(f.owner.user.id, revoked.id, { expected_attempt: 1 }); assert.equal(retry.requested_by, f.owner.user.id);
  await f.service.work(); assert.equal((await f.service.get(f.owner.user.id, revoked.id)).status, 'simulated');
});
