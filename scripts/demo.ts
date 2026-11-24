import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/app';
import { Db } from '../src/db';
import { provisionDevice } from '../src/devices';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';

async function main() {
  if ((process.env.DATA_MODE ?? 'offline') !== 'offline') throw new Error('演示仅支持 DATA_MODE=offline 合成数据');
  process.env.PUSH_MODE = 'mock';
  const db = await Db.open(), app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`, fixture = JSON.parse(readFileSync(resolve('fixtures/walk.json'), 'utf8'));
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, deviceToken?: string) {
      const response = await fetch(`${base}${path}`, {
        method, headers: { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}), ...(deviceToken ? { 'x-device-token': deviceToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json() as any;
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${result.code ?? ''} ${result.message ?? ''}`);
      return result;
    }
    const email = `offline-${randomUUID()}@example.invalid`, password = 'Doogy-offline-2026!';
    const account = await api('/auth/register', 'POST', { email, password, household_name: '合成演示家庭' });
    access = account.access_token;
    const pet = await api('/pets', 'POST', { household_id: account.household.id, name: '豆吉（合成）', species: 'dog' });
    const device = (await provisionDevice(db, { serial_no: `DEMO-${randomUUID()}` }));
    await api('/devices/claim', 'POST', { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    await api('/geofences', 'POST', { pet_id: pet.id, name: '演示安全区', geometry: fixture.geometry, buffer_m: 10, confirm_points: 2 });
    const now = db.clock().getTime(), at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
    let seq = 0;
    for (const { relative_time_seconds, ...payload } of fixture.locations) {
      await api('/ingest/events', 'POST', {
        schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'demo-boot',
        device_ts: at(relative_time_seconds), seq: seq++, event_type: 'location.reported', firmware_version: 'simulator-0.1', payload,
      }, device.device_token);
    }
    await api('/ingest/events', 'POST', {
      schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'demo-boot', device_ts: at(-20),
      seq: seq++, event_type: 'activity.reported', payload: {
        start_at: at(fixture.activity.start_relative_seconds), end_at: at(fixture.activity.end_relative_seconds),
        steps: fixture.activity.steps, active_seconds: fixture.activity.active_seconds, estimated: true,
      },
    }, device.device_token);
    await app.get(TelemetryService).work();
    await app.get(NotificationService).dispatch();
    await api('/care-records', 'POST', { pet_id: pet.id, type: 'weight', value: { weight_kg: 12.5 }, recorded_at: at(-10), source: 'owner', notes: '合成体重，仅供开发演示' });
    const safety = (await db.all('SELECT type,status FROM safety_events WHERE pet_id=? ORDER BY occurred_at', pet.id));
    assert.equal(safety.filter(event => event.type === 'geofence.exited').length, 1);
    assert.equal(safety.filter(event => event.type === 'geofence.entered').length, 1);
    assert.equal(safety.filter(event => event.type === 'battery.low').length, 1);
    const notifications = (await db.all('SELECT status,COUNT(*) AS count FROM notifications WHERE user_id=? GROUP BY status', account.user.id));
    const latest = await api(`/pets/${pet.id}/location/latest`);
    assert.ok(latest);
    console.log(JSON.stringify({
      mode: 'offline', database_driver: db.driver,
      database: db.driver === 'postgres' ? 'PostgreSQL/PostGIS' : process.env.DB_PATH ?? './data/doogy.db',
      login: { email, password }, pet_id: pet.id, device_id: device.device_id,
      location_points: (await db.get('SELECT COUNT(*) AS count FROM locations WHERE pet_id=?', pet.id))!.count,
      safety_events: safety, notifications,
      result: '注册、建宠、绑定、遥测入库、越界、返回、模拟通知与手工照护均通过',
    }, null, 2));
  } finally { await app.close(); await db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
