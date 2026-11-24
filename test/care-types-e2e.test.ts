import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`照护类型HTTP：${mode}模式的排泄、自定义编辑、过滤和旧类型在双驱动一致`, async () => {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-17T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db;
  const app = await createApp({ db, quiet: true }), originalFetch = globalThis.fetch;
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
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    const register = (name: string) => api('/auth/register', 'POST', {
      email: `care-types-${name}-${mode}@example.invalid`, password: 'Synthetic-care-types-http-2026', timezone: 'UTC',
    });
    const owner = await register('owner'), viewer = await register('viewer'); access = owner.access_token;
    const invitation = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invitation.token}/accept`, 'POST', undefined, undefined, 200, viewer.access_token);
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'HTTP care types', weight_kg: 9 });
    const careBody = (type: string, value: Record<string, any>, extra: Record<string, any> = {}) => ({ pet_id: pet.id, type, value, recorded_at: db.now(), ...extra });
    const oldTypes = [
      ['weight', { weight_kg: 12 }], ['feeding', { grams: 100 }], ['medication', { name: '已遵医嘱记录' }],
      ['grooming', { task: '梳毛' }], ['note', { text: '状态良好' }],
    ] as const;
    for (const [type, value] of oldTypes) {
      const record = await api('/care-records', 'POST', careBody(type, value));
      assert.equal(record.custom_type, null); assert.equal(record.source, 'owner'); assert.equal(record.notes, '');
      assert.deepEqual(record.value, value);
    }
    const toilets: any[] = [];
    for (const kind of ['urination', 'defecation', 'both']) {
      const value = { kind, location: '户外', details: { observed: true }, weight_kg: 99 };
      const record = await api('/care-records', 'POST', careBody('toileting', value));
      assert.equal(record.custom_type, null); assert.deepEqual(record.value, value); toilets.push(record);
    }
    const customBody = careBody('custom', { duration: 5, equipment: ['牙刷'], completed: true, comment: null }, { custom_type: '  刷牙  ' });
    const custom = await api('/care-records', 'POST', customBody, 'custom-create');
    assert.equal(custom.custom_type, '刷牙');
    assert.deepEqual(await api('/care-records', 'POST', { ...customBody, custom_type: '刷牙' }, 'custom-create'), custom);
    const path = `/care-records/${custom.id}`, listPath = `/pets/${pet.id}/care-records`;
    assert.equal((await api(path, 'GET', undefined, undefined, 200, viewer.access_token)).custom_type, '刷牙');
    await api(path, 'PATCH', { custom_type: '只读成员改名' }, undefined, 403, viewer.access_token);
    await api('/care-records', 'POST', careBody('custom', {}, { custom_type: '只读成员创建' }), undefined, 403, viewer.access_token);
    const invalidCreate = [
      careBody('custom', {}), careBody('custom', {}, { custom_type: '' }), careBody('custom', {}, { custom_type: '   ' }),
      careBody('custom', {}, { custom_type: null }), careBody('custom', {}, { custom_type: 'x'.repeat(101) }),
      careBody('note', {}, { custom_type: '不适用' }), careBody('toileting', {}), careBody('toileting', { kind: 'other' }),
      careBody('toileting', { kind: null }), careBody('toileting', { kind: 'urination' }, { custom_type: '不适用' }),
    ];
    for (const body of invalidCreate) await api('/care-records', 'POST', body, undefined, 400);
    for (const custom_type of ['', '   ', null, 'x'.repeat(101)]) await api(path, 'PATCH', { custom_type }, undefined, 400);
    await api(`/care-records/${toilets[0].id}`, 'PATCH', { custom_type: '不适用' }, undefined, 400);
    await api(`/care-records/${toilets[0].id}`, 'PATCH', { value: {} }, undefined, 400);
    now += 1000;
    const renamed = await api(path, 'PATCH', { custom_type: '  口腔护理  ', notes: '愿意配合' }, 'custom-edit');
    assert.equal(renamed.custom_type, '口腔护理'); assert.deepEqual(renamed.value, custom.value);
    assert.deepEqual(await api(path, 'PATCH', { custom_type: '口腔护理', notes: '愿意配合' }, 'custom-edit'), renamed);
    await api(path, 'PATCH', { custom_type: '散步' }, 'custom-edit', 409);
    now += 1000;
    const emptied = await api(path, 'PATCH', { value: {}, type: 'weight' });
    assert.equal(emptied.type, 'custom'); assert.equal(emptied.custom_type, '口腔护理'); assert.deepEqual(emptied.value, {});
    const editedToilet = await api(`/care-records/${toilets[0].id}`, 'PATCH', { value: { kind: 'both', notes: '补录排便' } });
    assert.deepEqual(editedToilet.value, { kind: 'both', notes: '补录排便' }); assert.equal(editedToilet.custom_type, null);
    const filter = `custom_type=${encodeURIComponent('  口腔护理  ')}`;
    assert.deepEqual((await api(`${listPath}?type=custom&${filter}`)).items.map((row: any) => row.id), [custom.id]);
    assert.deepEqual((await api(`${listPath}?type=toileting&${filter}`)).items, []);
    assert.deepEqual((await api(`${listPath}?custom_type=${encodeURIComponent('口腔')}`)).items, []);
    assert.equal((await api(`${listPath}?type=toileting`)).items.length, 3);
    await api(`${listPath}?custom_type=%20%20`, 'GET', undefined, undefined, 400);
    assert.equal((await api(`/pets/${pet.id}`)).weight_kg, 12);
    const overview = await api(`/pets/${pet.id}/overview?date=2026-11-17`);
    assert.equal(overview.care_records.length, 9);
    assert.equal(overview.care_records.find((row: any) => row.id === custom.id).custom_type, '口腔护理');
    const history = await api(`${path}/history`);
    assert.equal(history.revisions.length, 2); assert.equal(history.revisions[0].record.custom_type, '刷牙');
    assert.equal(history.revisions[1].record.custom_type, '口腔护理'); assert.deepEqual(history.current.value, {});
    now += 1000;
    const withdrawn = await api(`${path}/withdraw`, 'POST', { reason: '重复记录' }, 'custom-withdraw');
    assert.equal(withdrawn.custom_type, '口腔护理'); assert.ok(withdrawn.withdrawn_at);
    assert.deepEqual(await api(path), withdrawn);
    assert.deepEqual((await api(`${listPath}?status=withdrawn&${filter}`)).items.map((row: any) => row.id), [custom.id]);
    assert.equal((await api(`${listPath}?type=custom`)).items.length, 0);
    assert.equal((await api(`/pets/${pet.id}/overview?date=2026-11-17`)).care_records.length, 8);
    assert.equal((await api(`/pets/${pet.id}`)).weight_kg, 12);
    const exported = await api(`/auth/data-export/care_records?household_id=${owner.household.id}`);
    const exportedCustom = exported.items.find((row: any) => row.id === custom.id);
    assert.equal(exportedCustom.custom_type, '口腔护理'); assert.deepEqual(exportedCustom.value, {});
    assert.equal(exportedCustom.withdrawn_at, withdrawn.withdrawn_at);
    assert.equal(exported.items.find((row: any) => row.id === toilets[0].id).custom_type, null);
    const exportedHistory = await api(`/auth/data-export/care_record_revisions?household_id=${owner.household.id}`);
    const snapshots = exportedHistory.items.filter((row: any) => row.record_id === custom.id).map((row: any) => row.record);
    assert.equal(snapshots.length, 3); assert.ok(snapshots.some((row: any) => row.custom_type === '刷牙'));
    assert.ok(snapshots.some((row: any) => row.custom_type === '口腔护理' && Object.keys(row.value).length === 0));
    const schema = await (await fetch(`${origin}/openapi.json`)).json() as any;
    const create = schema.paths['/api/v1/care-records'].post.requestBody.content['application/json'].schema;
    assert.ok(create.properties.type.enum.includes('toileting')); assert.ok(create.properties.type.enum.includes('custom'));
    assert.ok(create.properties.custom_type);
    const update = schema.paths['/api/v1/care-records/{id}'].patch.requestBody.content['application/json'].schema;
    assert.ok(update.properties.custom_type);
    assert.equal((await api('/health')).mode, mode); assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
