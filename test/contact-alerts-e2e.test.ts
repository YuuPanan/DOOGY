import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { ContactAlertsService } from '../src/contact-alerts';
import { contactAlertFixture, contactAlertBody, selectedContact } from './contact-alerts-fixture';

for (const mode of ['offline', 'api'] as const) test(`contact alerts HTTP ${mode}: explicit recipients, truthful per-person outcomes and protected retries`, async () => {
  const f = await contactAlertFixture(mode), app = await createApp({ db: f.db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0, cacheControl: string | null = null;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    async function api(path: string, method = 'GET', body?: unknown, key?: string, expected = method === 'POST' ? 202 : 200, token = f.owner.access_token) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      cacheControl = response.headers.get('cache-control'); const value = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    const path = `/pets/${f.pet.id}/contact-alerts`, input = contactAlertBody([selectedContact(f.granted), selectedContact(f.unknown, 'phone')]);
    await api(path, 'POST', { ...input, recipients: [] }, undefined, 400);
    await api(path, 'POST', { ...input, share_id: f.db.id() }, undefined, 400);
    await api(path, 'POST', input, undefined, 403, f.viewer.access_token);
    await api(path, 'POST', contactAlertBody([selectedContact(f.other)]), undefined, 404);
    await api(path, 'POST', contactAlertBody([{ ...selectedContact(f.granted), expected_version: 99 }]), undefined, 409);
    const queued = await api(path, 'POST', input, 'alert-once'); assert.equal(cacheControl, 'no-store'); assert.equal(queued.status, 'pending');
    assert.equal((await api(path, 'POST', input, 'alert-once')).id, queued.id);
    const resource = `/contact-alerts/${queued.id}`;
    assert.equal((await api(resource, 'GET', undefined, undefined, 200, f.viewer.access_token)).counts.pending, 2);
    await api(resource, 'GET', undefined, undefined, 404, f.stranger.access_token);
    const worker = app.get(ContactAlertsService); assert.equal(await worker.work(), 1); assert.equal(await worker.work(), 0);
    const processed = await api(resource); assert.equal(processed.content_scope, 'message_only'); assert.equal(processed.location_link_included, false);
    assert.equal(processed.recipient_consent_verified, false); assert.ok(processed.recipients.every((row: any) => !row.consent_verified));
    assert.equal(processed.recipients.find((row: any) => row.contact_id === f.unknown.id).error_code, 'RECIPIENT_CONSENT_REQUIRED');
    const granted = processed.recipients.find((row: any) => row.contact_id === f.granted.id);
    if (mode === 'offline') { assert.equal(processed.status, 'partial'); assert.equal(granted.status, 'simulated'); assert.equal(granted.execution_source, 'offline_demo'); }
    else { assert.equal(processed.status, 'failed'); assert.equal(granted.status, 'failed'); assert.equal(granted.error_code, 'CHANNEL_NOT_CONFIGURED'); }
    const bodyText = JSON.stringify(processed); assert.equal(bodyText.includes(f.granted.email), false); assert.equal(bodyText.includes(f.unknown.phone), false);
    await api(resource + '/retry', 'POST', { expected_attempt: 1 }, undefined, 403, f.viewer.access_token);
    const retryable = await api(path, 'POST', contactAlertBody([selectedContact(f.granted)]), 'retryable-alert'); await worker.work();
    if (mode === 'api') {
      const retried = await api(`/contact-alerts/${retryable.id}/retry`, 'POST', { expected_attempt: 1 }, 'retry-once');
      assert.equal(retried.id, retryable.id); assert.equal(retried.attempt, 2);
      await api(`/contact-alerts/${retryable.id}/retry`, 'POST', { expected_attempt: 1 }, undefined, 409);
      await worker.work();
      assert.equal((await api(`/contact-alerts/${retryable.id}`)).recipients[0].error_code, 'CHANNEL_NOT_CONFIGURED');
    } else await api(`/contact-alerts/${retryable.id}/retry`, 'POST', { expected_attempt: 1 }, undefined, 409);
    const cancel = await api(path, 'POST', contactAlertBody([selectedContact(f.granted)]), 'cancel-alert');
    const cancelled = await api(`/contact-alerts/${cancel.id}/cancel`, 'POST', { expected_attempt: 1 }, 'cancel-once', 200);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(await worker.work(), 0);
    const expiringBody = contactAlertBody([selectedContact(f.granted)], { expires_in_seconds: 60 });
    const expiring = await api(path, 'POST', expiringBody, 'expired-alert'); f.advance(61000);
    const expired = await api(`/contact-alerts/${expiring.id}`); assert.equal(expired.status, 'failed'); assert.equal(expired.recipients[0].error_code, 'REQUEST_EXPIRED');
    const replayed = await api(path, 'POST', expiringBody, 'expired-alert'); assert.equal(replayed.id, expiring.id); assert.equal(replayed.expires_at, expiring.expires_at);
    await api(`/contact-alerts/${expiring.id}/retry`, 'POST', { expected_attempt: 1 }, undefined, 409);
    await f.contacts.delete(f.owner.user.id, f.granted.id, { expected_version: f.granted.version });
    const deleted = await api(resource);
    const old = deleted.recipients.find((row: any) => row.id === granted.id); assert.equal(old.contact_id, null);
    if (mode === 'offline') assert.equal(old.status, 'simulated'); else assert.equal(old.error_code, 'CONTACT_DELETED');
    const before = (await f.db.get('SELECT COUNT(*) AS n FROM contact_alerts'))!.n;
    await api(path, 'POST', input, 'alert-once', 404);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM contact_alerts'))!.n, before);
    await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
    await api(resource, 'GET', undefined, undefined, 404, f.viewer.access_token);
    const spec = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(spec.paths['/api/v1/pets/{id}/contact-alerts'].post); assert.ok(spec.paths['/api/v1/contact-alerts/{id}/retry'].post);
    assert.ok(spec.paths['/api/v1/contact-alerts/{id}/cancel'].post); assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await f.close(); }
});
