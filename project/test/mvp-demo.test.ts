import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { seedMvpDemo } from '../scripts/mvp-demo';
import { CareService } from '../src/care';
import { createApp } from '../src/app';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { ObservationsService } from '../src/observations';
import { ReportingService } from '../src/reporting';

test('MVP 演示种子通过真实业务服务生成可展示的家庭、活动、照护和模拟设备状态', async () => {
  process.env.DATA_MODE = 'offline';
  const db = new Db(':memory:', () => new Date('2026-11-17T06:00:00Z'));
  try {
    const result = await seedMvpDemo(db), app = await createApp({ db, quiet: true });
    try {
      const identity = app.get(IdentityService);
      const owner = await identity.login(result.owner), viewer = await identity.login(result.viewer);
      assert.equal((await identity.pets(owner.user.id)).items.length, 2);
      assert.equal((await identity.pets(viewer.user.id)).items.length, 2);
      assert.equal((await identity.households(viewer.user.id)).items.find(item => item.id === result.household_id)?.role, 'viewer');
      await assert.rejects(identity.updatePet(viewer.user.id, result.pet_id, { name: '不能修改' }));
      const care = app.get(CareService), overview = await care.overview(owner.user.id, result.pet_id, {});
      assert.equal(overview.pet.weight_kg, 8.6);
      assert.ok(overview.device);
      assert.equal(overview.device.connection_status, 'online');
      assert.equal(overview.device.battery_pct, 78);
      assert.equal(overview.geofences.items[0].state.effective_status, 'outside');
      assert.equal(result.location_points, 9);
      assert.equal(result.activity_samples, 8);
      assert.equal(result.events.filter(event => event.type === 'geofence.exited').length, 2);
      assert.equal(result.events.filter(event => event.type === 'geofence.entered').length, 1);
      assert.equal(result.events.filter(event => event.status === 'open').length, 1);
      assert.equal((await db.get("SELECT COUNT(*) AS count FROM notifications WHERE status='simulated'"))!.count, 6);
      const weekly = await care.weekly(owner.user.id, result.pet_id, {});
      assert.equal(weekly.days.length, 7);
      assert.ok(weekly.days.every((day: any) => day.steps > 0));
      const observation = await app.get(ObservationsService).get(viewer.user.id, result.pet_id, {});
      assert.equal(observation.local_date, '2026-11-16');
      const steps = observation.comparisons.find((item: { metric: string }) => item.metric === 'steps');
      assert.equal(steps.observed, 4000);
      assert.equal(steps.coverage_fraction, 1);
      assert.equal(steps.baseline_days, 6);
      assert.ok(steps.delta_percent <= -30);
      assert.deepEqual(observation.observations[0].evidence_ids, [steps.evidence_id]);
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM care_records'))!.count, 5);
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM care_attachments'))!.count, 1);
      const policy = await app.get(ReportingService).view(owner.user.id, result.device_id);
      assert.equal(policy.status, 'applied'); assert.equal(policy.execution_source, 'simulator');
      await assert.rejects(seedMvpDemo(db), /空数据库/);
    } finally { await app.close(); }
  } finally { await db.close(); }
});

test('MVP 午夜演示保留未开始的今日活动，照护记录仍位于当天且不创建未来样本', async () => {
  process.env.DATA_MODE = 'offline';
  const db = new Db(':memory:', () => new Date('2026-11-17T16:00:00Z'));
  try {
    const result = await seedMvpDemo(db);
    assert.equal(result.activity_samples, 7);
    assert.equal((await db.get('SELECT MAX(end_at) AS latest FROM activity_samples'))!.latest, db.now());
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM care_records WHERE recorded_at=?', db.now()))!.count, 5);
    assert.equal((await db.get('SELECT battery_pct FROM device_state WHERE device_id=?', result.device_id))!.battery_pct, 78);
  } finally { await db.close(); }
});
