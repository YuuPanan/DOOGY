import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { Db, Row } from '../src/db';
import { DevicesService } from '../src/devices';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';

const now = Date.parse('2026-11-17T06:00:00Z');
beforeEach(() => { process.env.FRESH_SECONDS = '300'; process.env.OFFLINE_SECONDS = '300'; });

function point(overrides: Row = {}): Row {
  return { id: 'location', pet_id: 'pet', device_id: 'device', device_ts: new Date(now - 2000).toISOString(),
    accuracy_m: 10, source: 'gnss', quality_flags_json: '[]', ...overrides };
}

function fixture(rows: Row[]) {
  const timingQueries: string[] = [], fenceQueries: string[] = [];
  const intervals = new Map<string, number>();
  let limit = 100;
  const db = {
    clock: () => new Date(now),
    pet: async () => ({ id: 'pet' }),
    all: async () => rows,
    get: async (sql: string, key: string) => {
      if (sql.includes('FROM reporting_policies')) {
        timingQueries.push(key);
        return intervals.has(key) ? { applied_json: JSON.stringify({ interval_seconds: intervals.get(key) }) } : undefined;
      }
      if (sql.includes('MAX(accuracy_limit_m)')) { fenceQueries.push(key); return { limit_m: limit }; }
      throw new Error(`Unexpected presentation query: ${sql}`);
    }
  } as unknown as Db;
  return { telemetry: new TelemetryService(db, {} as DevicesService, {} as NotificationService),
    timingQueries, fenceQueries, intervals, setLimit: (value: number) => { limit = value; } };
}

test('一页100个同设备轨迹点仅查询一次策略和围栏阈值，保留逐点展示', async () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => point({ id: `location-${i}` })));
  const result = await f.telemetry.locations('owner', 'pet', { limit: 100 });
  assert.equal(result.items.length, 100);
  assert.equal(new Set(result.items.map(row => row.id)).size, 100);
  assert.ok(result.items.every(row => row.freshness === 'fresh' && row.usable_for_tracking && row.usable_for_geofence));
  assert.deepEqual(f.timingQueries, ['device']);
  assert.deepEqual(f.fenceQueries, ['pet']);
});

test('历史轨迹中的不同设备分别读取策略，不把较慢设备的新鲜度用于其他设备', async () => {
  const old = new Date(now - 500_000).toISOString();
  const f = fixture([point({ id: 'slow', device_id: 'slow-device', device_ts: old }),
    point({ id: 'fast', device_id: 'fast-device', device_ts: old })]);
  f.intervals.set('slow-device', 600);
  f.intervals.set('fast-device', 15);
  const result = await f.telemetry.locations('owner', 'pet', { limit: 100 });
  assert.equal(result.items[0].freshness, 'fresh');
  assert.equal(result.items[0].usable_for_tracking, true);
  assert.equal(result.items[1].freshness, 'stale');
  assert.equal(result.items[1].usable_for_tracking, false);
  assert.deepEqual(f.timingQueries.sort(), ['fast-device', 'slow-device']);
  assert.equal(f.fenceQueries.length, 2);
});

test('策略和围栏阈值只在当前请求内复用，下次请求立即读取更改后的值', async () => {
  const f = fixture([point({ device_ts: new Date(now - 500_000).toISOString(), accuracy_m: 200, quality_flags_json: '["poor_accuracy"]' })]);
  const first = await f.telemetry.locations('owner', 'pet', { limit: 100 });
  assert.equal(first.items[0].freshness, 'stale');
  assert.equal(first.items[0].geofence_accuracy_limit_m, 100);
  assert.equal(first.items[0].usable_for_geofence, false);
  f.intervals.set('device', 600); f.setLimit(300);
  const second = await f.telemetry.locations('owner', 'pet', { limit: 100 });
  assert.equal(second.items[0].freshness, 'fresh');
  assert.equal(second.items[0].geofence_accuracy_limit_m, 300);
  assert.equal(second.items[0].usable_for_geofence, true);
  assert.equal(second.items[0].usable_for_tracking, false);
  assert.equal(f.timingQueries.length, 2);
  assert.equal(f.fenceQueries.length, 2);
});
