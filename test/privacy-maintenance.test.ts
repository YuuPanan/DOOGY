import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { openBackendFixture } from './backend-fixture';
import { IdentityService } from '../src/identity';
import { PrivacyService } from '../src/privacy';
import { NotificationService } from '../src/notifications';
import { privacyMaintenance } from '../scripts/privacy-maintenance';
import { createApp } from '../src/app';
import { provisionDevice, DevicesService } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { OperationsService } from '../src/operations';

test('隐私维护文件：独占导出、校验损坏拒绝、离线恢复重放幂等及注销后个人写入拒绝', async t => {
  process.env.DATA_MODE = 'offline';
  const source = await openBackendFixture(), restored = await openBackendFixture();
  t.after(async () => { await source.close(); await restored.close(); });
  const directory = await mkdtemp(join(tmpdir(), 'doogy-privacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = new IdentityService(source.db), password = 'Synthetic-maintenance-2026';
  const owner = await identity.register({ email: 'privacy-maintenance@example.invalid', password });
  // A restored pre-deletion database contains the original account and sessions.
  const row = (await source.db.get('SELECT * FROM users WHERE id=?', owner.user.id))!;
  await restored.db.run('INSERT INTO users(id,email,password_hash,created_at,closed_at) VALUES (?,?,?,?,?)', row.id,row.email,row.password_hash,row.created_at,row.closed_at);
  for (const session of await source.db.all('SELECT * FROM sessions')) await restored.db.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)',
    session.id,session.user_id,session.access_hash,session.refresh_hash,session.expires_at,session.refresh_expires_at,session.created_at);
  await new PrivacyService(source.db).closeAccount(owner.user.id, { password, confirmation: 'DELETE' });
  const notifications = new NotificationService(source.db);
  for (const request of [notifications.updatePreferences(owner.user.id,{battery:false}), notifications.registerToken(owner.user.id,{platform:'ios',token:'closed-account-private-token'})]) {
    await assert.rejects(request, error => error instanceof HttpException && error.getStatus() === 401);
  }
  const file = join(directory,'deletions.json'), exported = await privacyMaintenance(source.db,'export-log',file);
  assert.equal(exported.receipts,2);
  await assert.rejects(privacyMaintenance(source.db,'export-log',file), /EEXIST/);
  const log = JSON.parse(await readFile(file,'utf8'));
  assert.ok(!JSON.stringify(log).includes(owner.user.email)); assert.ok(!JSON.stringify(log).includes(row.password_hash));
  process.env.DATA_MODE = 'api';
  await assert.rejects(privacyMaintenance(restored.db,'replay-log',file), /offline/);
  process.env.DATA_MODE = 'offline';
  assert.equal((await privacyMaintenance(restored.db,'replay-log',file)).applied,2);
  assert.equal((await privacyMaintenance(restored.db,'replay-log',file)).applied,0);
  await assert.rejects(new IdentityService(restored.db).userFromAccess(owner.access_token));
  log.receipts[0].resource_id=randomUUID();
  const corrupt = join(directory,'corrupt.json'); await writeFile(corrupt,JSON.stringify(log));
  await assert.rejects(privacyMaintenance(restored.db,'replay-log',corrupt),/CHECKSUM/);
});

test('隐私日志含所有权交接时保持原始摘要，可从旧副本重放并注销原owner', async t => {
  process.env.DATA_MODE = 'offline';
  const source = await openBackendFixture(), restored = await openBackendFixture();
  t.after(async () => { await source.close(); await restored.close(); });
  const directory = await mkdtemp(join(tmpdir(), 'doogy-privacy-transfer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = new IdentityService(source.db), password = 'Synthetic-transfer-checksum-2026';
  const owner = await identity.register({ email: 'transfer-checksum-owner@example.invalid', password });
  const target = await identity.register({ email: 'transfer-checksum-target@example.invalid', password });
  const invitation = await identity.invite(owner.user.id, owner.household.id, { email: target.user.email, role: 'caregiver' });
  await identity.accept(target.user.id, invitation.token);
  for (const table of ['users','households','household_members','sessions','household_settings']) for (const row of await source.db.all(`SELECT * FROM ${table}`)) {
    const columns = Object.keys(row);
    await restored.db.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`, ...columns.map(column=>row[column]));
  }
  const privacy = new PrivacyService(source.db);
  await privacy.transferOwner(owner.user.id, owner.household.id, { password, new_owner_user_id: target.user.id });
  await privacy.closeAccount(owner.user.id, { password, confirmation: 'DELETE' });
  const file = join(directory,'transfer-log.json');
  await privacyMaintenance(source.db,'export-log',file);
  const log = JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(Object.keys(log.receipts[0].payload), ['previous_owner_user_id','new_owner_user_id','device_ids']);
  assert.equal((await privacyMaintenance(restored.db,'replay-log',file)).applied, 2);
  assert.equal((await restored.db.get('SELECT owner_user_id FROM households WHERE id=?', owner.household.id))!.owner_user_id, target.user.id);
  await assert.rejects(new IdentityService(restored.db).userFromAccess(owner.access_token));
  assert.equal((await privacyMaintenance(restored.db,'replay-log',file)).applied, 0);
});

test('保留策略HTTP：owner密码启用、零写预览、跨数据库清理及过期消息不能重新入库或重试', async t => {
  process.env.DATA_MODE = 'offline';
  let now = Date.parse('2026-10-01T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(now)), db=backend.db;
  const app=await createApp({db,quiet:true});
  t.after(async()=>{await app.close(); await backend.close();});
  await app.listen(0,'127.0.0.1'); const base=`${await app.getUrl()}/api/v1`;
  const password='Synthetic-retention-http-2026', identity=new IdentityService(db);
  const owner=await identity.register({email:'retention-http@example.invalid',password});
  const pet=await identity.createPet(owner.user.id,{household_id:owner.household.id,name:'Retention HTTP pet'});
  const device=await provisionDevice(db,{serial_no:'RETENTION-HTTP'});
  const devices=new DevicesService(db); await devices.claim(owner.user.id,{...device,pet_id:pet.id});
  const telemetry=new TelemetryService(db,devices,new NotificationService(db));
  const event={schema_version:'1.0',event_id:randomUUID(),device_id:device.device_id,device_ts:db.now(),seq:1,boot_id:'retention-http',event_type:'location.reported',payload:{lat:31.23,lon:121.47,accuracy_m:5,source:'gnss'}};
  await telemetry.ingest(event,device.device_token); await telemetry.work();
  const pending={...event,event_id:randomUUID(),seq:2}; await telemetry.ingest(pending,device.device_token);
  now+=30*86400000;
  const session=await identity.login({email:owner.user.email,password});
  const request=async(method:string,suffix:string,body?:unknown,status=200)=>{
    const response=await fetch(`${base}/households/${owner.household.id}/retention${suffix}`,{method,headers:{authorization:`Bearer ${session.access_token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json() as any; assert.equal(response.status,status,JSON.stringify(value)); return value;
  };
  assert.equal((await request('GET','')).enabled,false);
  await request('PATCH','',{password:'Wrong-retention-password',enabled:true,telemetry_days:1,activity_days:2,safety_days:3},401);
  await request('PATCH','',{password,enabled:false,telemetry_days:1,activity_days:2,safety_days:3});
  assert.equal((await request('POST','/preview')).households[0].counts.locations,1);
  assert.equal((await request('POST','/run',{password})).households[0].skipped,'disabled');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM locations'))!.n,1);
  await request('PATCH','',{password,enabled:true,telemetry_days:1,activity_days:2,safety_days:3});
  const preview=await request('POST','/preview'); assert.equal(preview.households[0].counts.locations,1);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM locations'))!.n,1);
  const run=await request('POST','/run',{password}); assert.deepEqual(run.households[0].counts,preview.households[0].counts);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM locations'))!.n,0);
  assert.equal((await db.get('SELECT envelope_json FROM device_events WHERE event_id=?',event.event_id))!.envelope_json,'{}');
  await assert.rejects(telemetry.ingest(event,device.device_token),error=>error instanceof HttpException&&(error.getResponse() as any).code==='EVENT_DATA_EXPIRED');
  await assert.rejects(new OperationsService(db).retry(owner.user.id,pending.event_id,{reason:'Cannot replay expired private data'}),error=>error instanceof HttpException&&(error.getResponse() as any).code==='EVENT_DATA_EXPIRED');
  const schema=await(await fetch(`${await app.getUrl()}/openapi.json`)).json() as any;
  for(const path of ['/api/v1/households/{id}/retention','/api/v1/households/{id}/retention/preview','/api/v1/households/{id}/retention/run']) assert.ok(schema.paths[path]);
});
