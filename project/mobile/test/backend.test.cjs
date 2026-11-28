const { strict: assert } = require('node:assert');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { ApiClient, ApiError } = require('../.test-dist/client.js');
const { accountExport } = require('../.test-dist/accountExport.js');
const { loadSafetyRange } = require('../.test-dist/safetyHistory.js');
const { Db } = require('../../dist/src/db.js');
const { createApp } = require('../../dist/src/app.js');
const { AssistantService } = require('../../dist/src/assistant.js');
const { ContactAlertsService } = require('../../dist/src/contact-alerts.js');

test('mobile client talks to an isolated real offline backend through identity, care, wellness, alerts, assistant and complete export', { timeout: 30000 }, async () => {
  // Db loads checked-in SQL relative to cwd. No environment file is loaded and no
  // on-disk application database or hardware credential is used by this test.
  process.chdir(resolve(__dirname, '../..'));
  process.env.DATA_MODE = 'offline'; process.env.DB_DRIVER = 'sqlite'; process.env.MANAGED_BACKUP_ENABLED = 'false';
  process.env.SUPPORT_ADMIN_USER_IDS = ''; process.env.DEVICE_ADMIN_USER_IDS = '';
  for (const key of ['DATABASE_URL', 'DOOGY_DEMO', 'PUSH_WEBHOOK_URL', 'PUSH_WEBHOOK_TOKEN', 'VENDOR_WEBHOOK_SECRET']) delete process.env[key];
  const db = new Db(':memory:', () => new Date('2026-11-24T12:00:00.000Z'));
  let app; const nativeFetch = globalThis.fetch; let externalCalls = 0;
  try {
    app = await createApp({ db, quiet: true }); await app.listen(0, '127.0.0.1'); const origin = await app.getUrl();
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.origin !== origin) { externalCalls++; throw new Error('External calls are forbidden by the isolated mobile backend test'); }
      return nativeFetch(input, init);
    };
    function client() {
      let token = null;
      const api = new ApiClient(origin, { read: async () => token, write: async value => { token = value; } });
      return { api, saved: () => token };
    }
    const owner = client(), viewer = client(), outsider = client();
    const password = 'Synthetic-mobile-backend-2026', email = 'mobile-backend-owner@example.invalid';
    const registered = await owner.api.post('/auth/register', { email, password, timezone: 'UTC', display_name: 'Synthetic mobile owner' });
    await owner.api.setSession(registered);
    assert.equal((await owner.api.get('/health')).mode, 'offline');
    assert.equal((await owner.api.get('/auth/me')).id, registered.user.id);
    assert.equal((await owner.api.get('/households')).items[0].id, registered.household.id);
    const newGuide = await owner.api.get('/auth/onboarding');
    assert.equal(newGuide.next_step, 'create_or_select_pet'); assert.equal(newGuide.completed_at, null);
    const pet = await owner.api.post('/pets', { household_id: registered.household.id, name: 'Synthetic App pet' }, 'backend-pet-once');
    assert.equal((await owner.api.get('/pets')).items[0].id, pet.id);
    const chosenGuide = await owner.api.patch('/auth/onboarding', { pet_id: pet.id, expected_version: newGuide.version });
    assert.equal(chosenGuide.next_step, 'connect_collar'); assert.equal(chosenGuide.bluetooth.status, 'unknown');
    await assert.rejects(owner.api.patch('/auth/onboarding', { pet_id: pet.id, collar_choice: 'completed', completed: true, expected_version: chosenGuide.version }), error => error instanceof ApiError && error.code === 'COLLAR_NOT_BOUND');
    const finishedGuide = await owner.api.patch('/auth/onboarding', { pet_id: pet.id, collar_choice: 'skipped', completed: true, expected_version: chosenGuide.version });
    assert.equal(finishedGuide.next_step, 'done'); assert.equal(finishedGuide.binding, null); assert.equal(finishedGuide.device_report.status, 'unbound');

    const careInput = { pet_id: pet.id, type: 'note', value: { text: 'Synthetic owner note; no sensor data' }, recorded_at: '2026-11-24T10:00:00Z' };
    const care = await owner.api.post('/care-records', careInput, 'backend-care-once');
    assert.equal((await owner.api.post('/care-records', careInput, 'backend-care-once')).id, care.id);
    assert.equal((await owner.api.get(`/pets/${pet.id}/care-records`)).items.length, 1);
    const goals = await owner.api.put(`/pets/${pet.id}/goals`, { effective_date: '2026-11-24', expected_version: 0, targets: { steps: 1200, active_minutes: 30 }, source: 'synthetic_mobile_owner' });
    assert.equal(goals.version, 1);
    const progress = await owner.api.get(`/pets/${pet.id}/goals?date=2026-11-24&timezone=UTC`);
    assert.equal(progress.goals.id, goals.id); assert.equal(progress.progress.steps.actual, null);
    const checkPath = `/pets/${pet.id}/body-check-ins?date=2026-11-24&timezone=UTC`;
    const check = await owner.api.put(checkPath, { expected_version: 0, values: { appetite: '主人原文：照常', movement: '主人原文：未额外观察' }, observed_at: '2026-11-24T10:00:00Z' });
    assert.equal(check.version, 1); assert.equal(check.values.energy, null); assert.equal((await owner.api.get(checkPath)).values.appetite, '主人原文：照常');
    const assessment = await owner.api.get(`/pets/${pet.id}/observations?date=2026-11-23&timezone=UTC`);
    const health = await owner.api.get(`/pets/${pet.id}/health-observations?timezone=UTC`);
    assert.ok(health.items.some(item => item.id === assessment.id));
    await owner.api.patch(`/health-observations/${assessment.id}/read`);
    assert.ok((await owner.api.get(`/health-observations/${assessment.id}`)).read_at);
    const overview = await owner.api.get(`/pets/${pet.id}/overview`); assert.equal(overview.device, null); assert.equal(overview.location, null);
    const current = await owner.api.get(`/pets/${pet.id}/observations/current?timezone=UTC`);
    assert.equal(current.pet_id, pet.id); assert.equal(current.local_date, '2026-11-24');
    const todaySafety = await loadSafetyRange(owner.api, pet.id, 'today', 'UTC');
    const safetyHistory = await owner.api.get(`/pets/${pet.id}/safety-events?${new URLSearchParams({ from: todaySafety.from, to: todaySafety.to })}`);
    assert.deepEqual(safetyHistory.items, []); assert.deepEqual(safetyHistory.range, { from: todaySafety.from, to: todaySafety.to });
    const retentionPath = `/households/${registered.household.id}/retention`;
    assert.equal((await owner.api.get(retentionPath)).enabled, false);
    await owner.api.patch(retentionPath, { password, enabled: false, telemetry_days: 30, activity_days: 90, safety_days: 90 });
    const retention = await owner.api.get(retentionPath); assert.equal(retention.telemetry_days, 30);
    const retentionPreview = await owner.api.post(`${retentionPath}/preview`, {});
    assert.equal(retentionPreview.dry_run, true); assert.equal(retentionPreview.households[0].household_id, registered.household.id);
    assert.equal((await owner.api.get(`/care-records/${care.id}`)).id, care.id);

    const granted = await owner.api.post(`/households/${registered.household.id}/contacts`, { name: 'Synthetic consented contact', email: 'synthetic-recipient@example.invalid', consent: { status: 'reported_granted' } });
    const unknown = await owner.api.post(`/households/${registered.household.id}/contacts`, { name: 'Synthetic unknown contact', phone: '+86 13800000000' });
    const alertInput = { consent: true, message: 'Synthetic message only; no location link.', recipients: [
      { contact_id: granted.id, expected_version: granted.version, method: 'email' },
      { contact_id: unknown.id, expected_version: unknown.version, method: 'phone' },
    ] };
    const alert = await owner.api.post(`/pets/${pet.id}/contact-alerts`, alertInput, 'backend-alert-once');
    assert.equal(alert.status, 'pending'); assert.equal(await app.get(ContactAlertsService).work(), 1);
    const alertResult = await owner.api.get(`/contact-alerts/${alert.id}`);
    assert.equal(alertResult.status, 'partial'); assert.equal(alertResult.counts.simulated, 1); assert.equal(alertResult.counts.failed, 1);
    assert.equal(alertResult.location_link_included, false); assert.equal(alertResult.recipient_consent_verified, false);
    assert.equal(alertResult.recipients.find(row => row.contact_id === unknown.id).error_code, 'RECIPIENT_CONSENT_REQUIRED');
    assert.equal((await owner.api.post(`/pets/${pet.id}/contact-alerts`, alertInput, 'backend-alert-once')).id, alert.id);
    await owner.api.patch('/notification-preferences', { geofence: false });
    assert.equal((await owner.api.get('/notification-preferences')).geofence, false);
    assert.deepEqual((await owner.api.get('/notifications')).items, []);
    assert.deepEqual((await owner.api.get('/lessons')).items, []);
    assert.deepEqual((await owner.api.get('/learning-progress')).counts, { scope: 'all_current_published_lessons', available_count: 0, learned_count: 0 });

    const conversation = await owner.api.post(`/pets/${pet.id}/assistant-conversations`, { title: 'Synthetic mobile question' });
    const message = await owner.api.post(`/assistant-conversations/${conversation.id}/messages`, { question: '今天有哪些已记录的数据？', context: { kind: 'activity', date: '2026-11-24', timezone: 'UTC' } });
    assert.equal(message.status, 'pending'); assert.equal(await app.get(AssistantService).work(), 1);
    const answer = await owner.api.get(`/assistant-messages/${message.id}`);
    assert.equal(answer.status, 'succeeded'); assert.equal(answer.execution_source, 'offline_demo'); assert.equal(answer.result.simulated, true);

    const outsiderSession = await outsider.api.post('/auth/register', { email: 'mobile-backend-outsider@example.invalid', password, timezone: 'UTC' }); await outsider.api.setSession(outsiderSession);
    await assert.rejects(outsider.api.get(`/pets/${pet.id}/overview`), error => error instanceof ApiError && error.status === 404);
    const viewerSession = await viewer.api.post('/auth/register', { email: 'mobile-backend-viewer@example.invalid', password, timezone: 'UTC' }); await viewer.api.setSession(viewerSession);
    const invitation = await owner.api.post(`/households/${registered.household.id}/invitations`, { email: viewerSession.user.email, role: 'viewer' });
    await viewer.api.post(`/invitations/${invitation.token}/accept`);
    const viewerGuide = await viewer.api.get('/auth/onboarding');
    assert.equal((await viewer.api.patch('/auth/onboarding', { pet_id: pet.id, collar_choice: 'skipped', completed: true, expected_version: viewerGuide.version })).next_step, 'done');
    assert.equal((await viewer.api.get(`/pets/${pet.id}/overview`)).pet.id, pet.id);
    await assert.rejects(viewer.api.post('/care-records', careInput), error => error instanceof ApiError && error.status === 403 && error.code === 'READ_ONLY');
    await assert.rejects(viewer.api.get(`/assistant-conversations/${conversation.id}/messages`), error => error instanceof ApiError && error.status === 404);
    assert.equal((await viewer.api.get(retentionPath)).activity_days, 90);
    await assert.rejects(viewer.api.post(`${retentionPath}/preview`, {}), error => error instanceof ApiError && error.status === 403);

    const manifest = await owner.api.get('/auth/data-export');
    const exported = await accountExport(owner.api, manifest, async text => createHash('sha256').update(text).digest('hex'), () => assert.ok(owner.api.accessToken));
    const lines = exported.content.trimEnd().split('\n'), exportedRows = lines.map(line => JSON.parse(line));
    const complete = exportedRows.at(-1), records = exportedRows.filter(row => row.type === 'record');
    assert.equal(exportedRows[0].type, 'manifest'); assert.equal(complete.type, 'complete'); assert.equal(complete.rows, records.length);
    assert.equal(complete.rows, complete.counts.reduce((count, section) => count + section.records, 0));
    assert.equal(complete.content_sha256, createHash('sha256').update(lines.slice(0, -1).join('\n') + '\n').digest('hex'));
    for (const [section, id] of [['care_records', care.id], ['pet_goals', goals.id], ['body_check_ins', check.id], ['contact_alerts', alert.id], ['assistant_messages', message.id]])
      assert.ok(records.some(row => row.section === section && row.data.id === id), section);
    assert.equal(records.filter(row => row.section === 'contact_alert_recipients').length, 2);
    for (const record of records) for (const forbidden of ['password_hash', 'access_token', 'refresh_token', 'secret_hash', 'token_hash']) assert.equal(Object.hasOwn(record.data, forbidden), false);
    assert.equal(exported.content.includes(password), false);
    await assert.rejects(outsider.api.get(`/auth/data-export/pets?household_id=${registered.household.id}`), error => error instanceof ApiError && error.status === 404);

    const previousAccess = owner.api.accessToken, previousRefresh = owner.saved();
    await db.run('UPDATE sessions SET expires_at=? WHERE user_id=?', '2026-11-24T11:59:00.000Z', registered.user.id);
    assert.equal((await owner.api.get('/auth/me')).id, registered.user.id);
    assert.notEqual(owner.api.accessToken, previousAccess); assert.notEqual(owner.saved(), previousRefresh);
    const revokedAccess = owner.api.accessToken;
    await owner.api.logout(); assert.equal(owner.api.accessToken, null); assert.equal(owner.saved(), null);
    const denied = await fetch(`${origin}/api/v1/auth/me`, { headers: { authorization: `Bearer ${revokedAccess}` } }); assert.equal(denied.status, 401); await denied.arrayBuffer();
    const login = await owner.api.post('/auth/login', { email, password }); await owner.api.setSession(login);
    assert.equal((await owner.api.get('/auth/me')).id, registered.user.id); assert.equal((await owner.api.get(`/care-records/${care.id}`)).id, care.id);
    assert.equal((await owner.api.get('/auth/onboarding')).next_step, 'done');
    assert.equal(externalCalls, 0); assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
  } finally {
    globalThis.fetch = nativeFetch;
    try { if (app) await app.close(); } finally { await db.close(); }
  }
});
