import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { PrivacyService } from '../src/privacy';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`照护撤回HTTP：${mode}模式的当前事实、幂等、共享权限、导出和文档在双驱动保持一致`, async () => {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-17T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db;
  const app = await createApp({ db, quiet: true });
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, key?: string, expected = method === 'POST' ? 201 : 200, token = access) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, JSON.stringify(value)); return value;
    }
    const password = 'Synthetic-care-withdrawal-http-2026';
    const register = (name: string) => api('/auth/register', 'POST', { email: `care-${name}-${mode}@example.invalid`, password });
    const owner = await register('owner'), author = await register('author'), caregiver = await register('caregiver'), viewer = await register('viewer'), outsider = await register('outsider');
    access = owner.access_token;
    for (const [member, role] of [[author, 'caregiver'], [caregiver, 'caregiver'], [viewer, 'viewer']]) {
      const invitation = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: member.user.email, role });
      await api(`/invitations/${invitation.token}/accept`, 'POST', undefined, undefined, 200, member.access_token);
    }
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'HTTP care withdrawal pet', weight_kg: 9 });
    const weight = await api('/care-records', 'POST', { pet_id: pet.id, type: 'weight', value: { weight_kg: 12 }, recorded_at: db.now() });
    const input = { pet_id: pet.id, type: 'note', value: { text: 'HTTP private care note' }, recorded_at: db.now() };
    const record = await api('/care-records', 'POST', input, 'http-create', 201, author.access_token);
    const path = `/care-records/${record.id}`, withdrawPath = `${path}/withdraw`;
    await api(path, 'GET', undefined, undefined, 401, '');
    await api(path, 'GET', undefined, undefined, 404, outsider.access_token);
    await api(withdrawPath, 'POST', { reason: 'viewer denied' }, undefined, 403, viewer.access_token);
    await api(withdrawPath, 'POST', { reason: 'other caregiver denied' }, undefined, 403, caregiver.access_token);
    await api(withdrawPath, 'POST', { reason: 'outsider denied' }, undefined, 404, outsider.access_token);
    now += 1000;
    const edited = await api(path, 'PATCH', { notes: 'first HTTP edit' }, 'http-edit', 200, caregiver.access_token);
    now += 1000;
    await api(path, 'PATCH', { notes: 'current HTTP edit' }, undefined, 200, author.access_token);
    assert.deepEqual(await api(path, 'PATCH', { notes: 'first HTTP edit' }, 'http-edit', 200, caregiver.access_token), edited);
    assert.equal((await api(path, 'GET', undefined, undefined, 200, viewer.access_token)).notes, 'current HTTP edit');
    await api(path, 'PATCH', { notes: 'different edit' }, 'http-edit', 409, caregiver.access_token);
    now += 1000;
    const reason = { reason: 'HTTP duplicate entry correction' };
    await api(withdrawPath, 'POST', { reason: '   ' }, undefined, 400, author.access_token);
    await api(withdrawPath, 'POST', { reason: 'x'.repeat(501) }, undefined, 400, author.access_token);
    const withdrawn = await api(withdrawPath, 'POST', { reason: `  ${reason.reason}  ` }, 'http-withdraw', 201, author.access_token);
    assert.ok(withdrawn.withdrawn_at); assert.equal(withdrawn.withdrawn_by, author.user.id); assert.equal(withdrawn.withdrawal_reason, reason.reason);
    assert.deepEqual(await api(withdrawPath, 'POST', reason, 'http-withdraw', 201, author.access_token), withdrawn);
    assert.deepEqual(await api(withdrawPath, 'POST', reason, undefined, 201, author.access_token), withdrawn);
    await api(withdrawPath, 'POST', { reason: 'different correction' }, 'http-withdraw', 409, author.access_token);
    assert.deepEqual(await api(path, 'GET', undefined, undefined, 200, viewer.access_token), withdrawn);
    const history = await api(`${path}/history`);
    assert.deepEqual(history.current, withdrawn); assert.equal(history.revisions.length, 3);
    assert.equal(history.revisions[2].record.withdrawn_at, null); assert.equal(history.revisions[2].record.notes, 'current HTTP edit');
    assert.deepEqual(await api('/care-records', 'POST', input, 'http-create', 201, author.access_token), record);
    assert.equal((await api(path)).withdrawn_at, withdrawn.withdrawn_at);
    const stalePatch = await api(path, 'PATCH', { notes: 'first HTTP edit' }, 'http-edit', 409, caregiver.access_token);
    assert.equal(stalePatch.code, 'CARE_RECORD_WITHDRAWN');
    assert.deepEqual((await api(`/pets/${pet.id}/care-records`)).items.map((row: any) => row.id), [weight.id]);
    assert.deepEqual((await api(`/pets/${pet.id}/care-records?status=withdrawn`)).items.map((row: any) => row.id), [record.id]);
    assert.equal((await api(`/pets/${pet.id}/care-records?status=all`)).items.length, 2);
    await api(`/pets/${pet.id}/care-records?status=invalid`, 'GET', undefined, undefined, 400);
    assert.deepEqual((await api(`/pets/${pet.id}/overview?date=2026-11-17`)).care_records.map((row: any) => row.id), [weight.id]);
    const exported = await api(`/auth/data-export/care_records?household_id=${owner.household.id}`, 'GET', undefined, undefined, 200, viewer.access_token);
    const exportedRecord = exported.items.find((row: any) => row.id === record.id);
    for (const field of ['withdrawn_at', 'withdrawn_by', 'withdrawal_reason']) assert.equal(exportedRecord[field], withdrawn[field]);
    const exportedHistory = await api(`/auth/data-export/care_record_revisions?household_id=${owner.household.id}`);
    assert.equal(exportedHistory.items.filter((row: any) => row.record_id === record.id).length, 3);
    const receipts = await new PrivacyService(db).receipts();
    const receipt = receipts.find(row => row.kind === 'care_withdrawal' && row.resource_id === record.id)!;
    assert.equal(receipt.deleted_at, withdrawn.withdrawn_at); assert.equal('payload' in receipt, false);
    const counts = await db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='care.withdrawn' AND resource_id=?", record.id);
    assert.equal(counts!.n, 1);
    await api(`/households/${owner.household.id}/members/${author.user.id}`, 'PATCH', { role: 'viewer' });
    await api(withdrawPath, 'POST', reason, 'http-withdraw', 403, author.access_token);
    await api(`/households/${owner.household.id}/members/${author.user.id}`, 'DELETE');
    await api(withdrawPath, 'POST', reason, 'http-withdraw', 404, author.access_token);
    await api(path, 'GET', undefined, undefined, 404, author.access_token);
    now += 1000;
    await api(`/care-records/${weight.id}/withdraw`, 'POST', { reason: 'owner corrects measurement' });
    assert.equal((await api(`/pets/${pet.id}`)).weight_kg, null);
    assert.equal((await api(`/pets/${pet.id}/care-records`)).items.length, 0);
    const schema = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(schema.paths['/api/v1/care-records/{id}'].get);
    for (const [route, method] of [['/api/v1/care-records/{id}', 'patch'], ['/api/v1/care-records/{id}/withdraw', 'post']]) {
      assert.ok(schema.paths[route][method].parameters.some((parameter: any) => parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key'));
    }
    const bodySchema = schema.paths['/api/v1/care-records/{id}/withdraw'].post.requestBody.content['application/json'].schema;
    assert.ok(bodySchema.properties.reason); assert.ok(bodySchema.required.includes('reason'));
    assert.equal((await api('/health')).mode, mode); assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
