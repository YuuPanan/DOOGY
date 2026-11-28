import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { openBackendFixture } from './backend-fixture';
import { privacyMaintenance } from '../scripts/privacy-maintenance';

for (const mode of ['offline','api'] as const) test(`设备命令幂等HTTP：${mode}模式重试、回执、重绑、TTL及维护在双驱动保持一致`, async () => {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-17T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db, app = await createApp({ db, quiet: true });
  try {
    await app.listen(0,'127.0.0.1'); const base = `${await app.getUrl()}/api/v1`, password = 'Synthetic-command-http-2026';
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, key?: string, expected = method === 'POST' ? 201 : 200, token = access, deviceToken?: string) {
      const response = await fetch(base + path, { method, headers: { 'content-type':'application/json', ...(token ? { authorization:`Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key':key } : {}), ...(deviceToken ? { 'x-device-token':deviceToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json() as any; assert.equal(response.status,expected,JSON.stringify(value)); return value;
    }
    const owner = await api('/auth/register','POST',{email:`command-http-${mode}@example.invalid`,password}); access = owner.access_token;
    const pet = await api('/pets','POST',{ household_id:owner.household.id,name:'HTTP retry pet' });
    const device = await provisionDevice(db,{serial_no:`IDEMPOTENCY-HTTP-${mode}`});
    await api('/devices/claim','POST',{...device,pet_id:pet.id});
    const path = `/devices/${device.device_id}/reporting-policy`, lostPath = `/devices/${device.device_id}/lost-mode`;
    const input = {mode:'home_idle',interval_seconds:600};
    const first = await api(path,'PUT',input,'http-policy');
    assert.deepEqual(await api(path,'PUT',{...input,expires_in_seconds:300},'http-policy'),first);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM device_commands'))!.n,1);
    await api(path,'PUT',{...input,interval_seconds:120},'http-policy',409);
    const receipt = await api(`/device-ingress/${device.device_id}/commands/${first.command_id}/ack`,'POST',
      {status:'applied',applied_version:first.desired_version},undefined,200,'',device.device_token);
    assert.equal(receipt.execution_source,mode === 'offline' ? 'simulator' : 'device');
    assert.equal((await api(path)).status,'applied');
    assert.deepEqual(await api(path,'PUT',input,'http-policy'),first);
    const started = await api(lostPath,'POST',{enabled:true,expires_in_seconds:60},'http-lost-start');
    now += 61000;
    assert.deepEqual(await api(lostPath,'POST',{enabled:true,expires_in_seconds:60},'http-lost-start'),started);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM lost_mode_sessions'))!.n,1);
    assert.equal((await api(path)).lost_mode.enabled,false);
    await api(lostPath,'POST',{enabled:true},'http-start-second');
    const closed = await api(lostPath,'POST',{enabled:false},'http-close');
    const latest = await api(lostPath,'POST',{enabled:true},'http-start-latest');
    assert.deepEqual(await api(lostPath,'POST',{enabled:false},'http-close'),closed);
    assert.equal((await api(path)).lost_mode.session.id,latest.lost_mode.session.id);
    assert.deepEqual(await api(path,'PUT',input,'http-policy'),first);
    const viewer = await api('/auth/register','POST',{email:`command-viewer-${mode}@example.invalid`,password});
    const invite = await api(`/households/${owner.household.id}/invitations`,'POST',{email:viewer.user.email,role:'viewer'});
    await api(`/invitations/${invite.token}/accept`,'POST',undefined,undefined,200,viewer.access_token);
    await api(path,'PUT',input,'http-policy',403,viewer.access_token);
    const code = await api(`/devices/${device.device_id}/unbind`,'POST');
    await api('/devices/claim','POST',{...code,pet_id:pet.id});
    const count = (await db.get('SELECT COUNT(*) AS n FROM device_commands'))!.n;
    await api(path,'PUT',input,'http-policy',409);
    await api(lostPath,'POST',{enabled:true,expires_in_seconds:60},'http-lost-start',409);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM device_commands'))!.n,count);
    now += 25 * 3600000;
    const freshLogin = await api('/auth/login','POST',{email:owner.user.email,password},undefined,200,''); access = freshLogin.access_token;
    const fresh = await api(path,'PUT',{mode:'home_active',interval_seconds:120},'http-policy');
    assert.notEqual(fresh.command_id,first.command_id);
    const before = (await db.get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n;
    const preview = await privacyMaintenance(db,'idempotency-preview');
    assert.ok(preview.matched_records > 0); assert.equal(preview.deleted_records,0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n,before);
    const cleaned = await privacyMaintenance(db,'idempotency-clean');
    assert.equal(cleaned.deleted_records,preview.matched_records);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM idempotency_keys'))!.n,1);
    const encoded = JSON.stringify({preview,cleaned});
    for (const value of ['http-policy','home_idle',owner.access_token,device.device_token,password]) assert.ok(!encoded.includes(value));
    const schema = await (await fetch(`${await app.getUrl()}/openapi.json`)).json() as any;
    for (const [route,method] of [['/api/v1/devices/{id}/reporting-policy','put'],['/api/v1/devices/{id}/lost-mode','post']]) {
      assert.ok(schema.paths[route][method].parameters.some((parameter: any) => parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key'));
    }
  } finally { await app.close(); await backend.close(); }
});
