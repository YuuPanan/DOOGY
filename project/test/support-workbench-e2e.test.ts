import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { openBackendFixture } from './backend-fixture';

const apiModule = new Function('url', 'return import(url)')(pathToFileURL(resolve('web/api.mjs')).href);
const denied = (status: number) => (error: any) => error.status === status;

for (const mode of ['offline', 'api'] as const) test(`客服工作台 HTTP：${mode} 模式绑定前求助、设备诊断与客服回复`, async t => {
  const previous = { DATA_MODE: process.env.DATA_MODE, SUPPORT_ADMIN_USER_IDS: process.env.SUPPORT_ADMIN_USER_IDS };
  process.env.DATA_MODE = mode;
  delete process.env.SUPPORT_ADMIN_USER_IDS;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const time = Date.parse('2026-11-18T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(time)), db = backend.db;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({ db, quiet: true });
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    const { ApiClient } = await apiModule, password = 'Synthetic-support-workbench-password';
    const owner = new ApiClient(base, null), viewer = new ApiClient(base, null), staff = new ApiClient(base, null);
    const ownerAccount = await owner.register({ email: 'support-owner@example.invalid', password });
    const viewerEmail = 'support-viewer@example.invalid';
    const viewerAccount = await viewer.register({ email: viewerEmail, password });
    const staffAccount = await staff.register({ email: 'support-staff@example.invalid', password });
    assert.equal(ownerAccount.user.support_staff, false);
    assert.equal(viewerAccount.user.support_staff, false);
    assert.equal(staffAccount.user.support_staff, false);
    await assert.rejects(staff.get('/admin/support/tickets'), denied(403));
    process.env.SUPPORT_ADMIN_USER_IDS = ` , ${staffAccount.user.id} , `;
    assert.equal((await staff.get('/auth/me')).support_staff, true);
    assert.deepEqual((await staff.get('/pets')).items, []);
    assert.equal((await owner.get('/auth/me')).support_staff, false);

    const userPath = '/support/tickets', adminPath = '/admin/support/tickets';
    const fixBinding = { category: 'binding', description: '合成工单：初次绑定失败，请协助' };
    assert.equal((await owner.get('/pets')).items.length, 0);
    await assert.rejects(owner.send('POST', userPath, { ...fixBinding, diagnostics_consent: true }), denied(400));
    await assert.rejects(owner.send('POST', userPath, { ...fixBinding, category: 'battery' }), denied(400));
    const unbound = await owner.send('POST', userPath, fixBinding, 'binding-help');
    const unaffiliatedFields = {
      device_id: null, pet_id: null, binding_id: null, diagnostics_consented_at: null,
      diagnostics_expires_at: null, diagnostics_revoked_at: null, diagnostics_json: null
    };
    const persisted = await db.get(`SELECT ${Object.keys(unaffiliatedFields).join(', ')} FROM support_tickets WHERE id=?`, unbound.id);
    assert.ok(persisted);
    assert.deepEqual({ ...persisted }, unaffiliatedFields);
    assert.deepEqual(unbound.diagnostics, { consented_at: null, expires_at: null, revoked_at: null, available: false });
    assert.equal((await owner.send('POST', userPath, { ...fixBinding, device_id: null }, 'binding-help')).id, unbound.id);
    assert.deepEqual((await owner.get(userPath)).items.map((ticket: any) => ticket.id), [unbound.id]);
    assert.deepEqual((await viewer.get(userPath)).items, []);
    await assert.rejects(viewer.get(`${userPath}/${unbound.id}`), denied(404));
    await assert.rejects(viewer.send('DELETE', `${userPath}/${unbound.id}/diagnostics-consent`), denied(404));
    assert.deepEqual(await owner.send('DELETE', `${userPath}/${unbound.id}/diagnostics-consent`), unbound);
    const helpReply = '已说明绑定码和设备核对步骤。';
    assert.deepEqual((await staff.get(adminPath)).items.map((ticket: any) => ticket.id), [unbound.id]);
    await staff.send('PATCH', `${adminPath}/${unbound.id}`, { status: 'resolved', reply: helpReply });
    const resolvedHelp = await owner.get(`${userPath}/${unbound.id}`);
    assert.equal(resolvedHelp.status, 'resolved');
    assert.deepEqual(resolvedHelp.history.map((entry: any) => [entry.status, entry.reply]), [['open', ''], ['resolved', helpReply]]);

    const householdId = ownerAccount.households[0].id;
    const invite = await owner.send('POST', `/households/${householdId}/invitations`, { email: viewerEmail, role: 'viewer' });
    await viewer.send('POST', `/invitations/${invite.token}/accept`);
    const pet = await owner.send('POST', '/pets', { household_id: householdId, name: '合成客服宠物' });
    const device = await provisionDevice(db, { serial_no: 'SYNTHETIC-SUPPORT-WORKBENCH' });
    await owner.send('POST', '/devices/claim', { pet_id: pet.id, device_id: device.device_id, claim_code: device.claim_code });

    const description = { device_id: device.device_id, category: 'battery', description: '合成工单：电量显示异常' };
    const textOnly = await viewer.send('POST', userPath, description);
    const consented = await owner.send('POST', userPath, { ...description, diagnostics_consent: true });
    const diagnosticsPath = `/admin/devices/${device.device_id}/diagnostics?ticket_id=`;
    assert.deepEqual(textOnly.diagnostics, { consented_at: null, expires_at: null, revoked_at: null, available: false });
    assert.equal(consented.diagnostics.available, true);
    assert.equal(consented.diagnostics.expires_at, new Date(time + 7 * 86_400_000).toISOString());
    assert.deepEqual((await owner.get(`${userPath}?status=open`)).items.map((ticket: any) => ticket.id), [consented.id]);
    assert.deepEqual((await viewer.get(userPath)).items.map((ticket: any) => ticket.id), [textOnly.id]);
    await assert.rejects(viewer.get(`${userPath}/${consented.id}`), denied(404));
    await assert.rejects(owner.get(`${userPath}/${textOnly.id}`), denied(404));
    await assert.rejects(owner.get(adminPath), denied(403));
    assert.equal((await staff.get(`${adminPath}?status=open`)).items.length, 2);
    await assert.rejects(staff.get(diagnosticsPath + textOnly.id), denied(404));
    await assert.rejects(staff.get(diagnosticsPath + unbound.id), denied(404));
    const diagnostics = await staff.get(diagnosticsPath + consented.id);
    assert.equal(diagnostics.consent_expires_at, consented.diagnostics.expires_at);
    assert.equal(diagnostics.snapshot.device.id, device.device_id);
    assert.ok(!JSON.stringify(diagnostics.snapshot).includes(device.device_token));

    const reply = '已检查本地合成设备，正在处理。';
    await staff.send('PATCH', `${adminPath}/${consented.id}`, { status: 'in_progress', reply });
    const ownedDetail = await owner.get(`${userPath}/${consented.id}`);
    assert.equal(ownedDetail.status, 'in_progress');
    assert.deepEqual(ownedDetail.history.map((entry: any) => [entry.status, entry.reply]), [['open', ''], ['in_progress', reply]]);
    assert.ok(!Object.hasOwn(ownedDetail, 'diagnostics_json'));
    const revoked = await owner.send('DELETE', `${userPath}/${consented.id}/diagnostics-consent`);
    assert.equal(revoked.diagnostics.revoked_at, db.now());
    assert.equal(revoked.diagnostics.available, false);
    await assert.rejects(staff.get(diagnosticsPath + consented.id), denied(404));
    assert.equal((await staff.get(`${adminPath}/${consented.id}`)).history.length, 2);

    delete process.env.SUPPORT_ADMIN_USER_IDS;
    assert.equal((await staff.get('/auth/me')).support_staff, false);
    await assert.rejects(staff.get(`${adminPath}/${consented.id}`), denied(403));
  } finally {
    try { await app?.close(); } finally { await backend.close(); }
  }
});
