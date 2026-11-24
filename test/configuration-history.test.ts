import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { test } from 'node:test';
import { clearDeviceReporting } from '../src/reporting';
import { configurationFixture, configurationRange, fenceInput } from './configuration-history-fixture';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;

test('fence history distinguishes renaming from rules, skips no-op writes and orders same-clock changes by actual sequence', async t => {
  const f = await configurationFixture(); t.after(f.close);
  assert.deepEqual((await f.history.list(f.owner.user.id, f.pet.id, {})).items, []);
  const original = await f.fences.create(f.owner.user.id, fenceInput(f.pet.id), 'fence-once');
  assert.deepEqual(await f.fences.create(f.owner.user.id, fenceInput(f.pet.id), 'fence-once'), original);
  await f.db.run("UPDATE geofence_states SET status='inside',candidate='outside',count=1,last_ts=?,last_judgment='inside' WHERE fence_id=?", f.db.now(), original.id);
  const renamed = await f.fences.update(f.caregiver.user.id, original.id, { name: 'Garden' });
  assert.equal(renamed.rule_version, original.rule_version); assert.equal(renamed.state.status, 'inside'); assert.equal(renamed.state.candidate, 'outside');
  const changed = await f.fences.update(f.caregiver.user.id, original.id, { buffer_m: 20 });
  assert.equal(changed.rule_version, original.rule_version + 1); assert.equal(changed.state.status, 'unknown');
  await f.fences.update(f.owner.user.id, original.id, { buffer_m: 20 }); await f.fences.update(f.owner.user.id, original.id, {});
  await f.fences.update(f.owner.user.id, original.id, { enabled: false }); await f.fences.update(f.owner.user.id, original.id, { enabled: false });
  const history = await f.history.list(f.viewer.user.id, f.pet.id, configurationRange);
  assert.equal(history.scope, 'recorded_changes_only'); assert.deepEqual(history.items.map((row: any) => row.version), [4, 3, 2, 1]);
  assert.equal(new Set(history.items.map((row: any) => row.changed_at)).size, 1);
  const [disabled, rules, name, created] = history.items;
  assert.equal(created.action, 'created'); assert.equal(created.before, null); assert.equal(created.before_version, null); assert.equal(created.after_version, 1);
  assert.equal(created.actor_user_id, f.owner.user.id); assert.deepEqual(created.after.geometry, original.geometry); assert.equal('state' in created.after, false);
  assert.deepEqual(name.changed_fields, ['name']); assert.equal(name.before.name, 'Home'); assert.equal(name.after.name, 'Garden');
  assert.equal(name.before_version, name.after_version); assert.equal(name.actor_user_id, f.caregiver.user.id); assert.equal(name.actor_kind, 'user');
  assert.deepEqual(rules.changed_fields, ['buffer_m']); assert.equal(rules.before_version, 1); assert.equal(rules.after_version, 2);
  assert.equal(disabled.reason, 'fence_disabled'); assert.equal(disabled.after_version, 3); assert.deepEqual(disabled.changed_fields, ['enabled']);
  await assert.rejects(f.history.list(f.stranger.user.id, f.pet.id, {}), status(404));
  assert.equal(JSON.stringify(history).includes(f.device.device_token), false);
  const page = await f.history.list(f.owner.user.id, f.pet.id, { limit: 1 }); f.advance(30000);
  const continued = await f.history.list(f.owner.user.id, f.pet.id, { limit: 1, cursor: page.next_cursor });
  assert.equal(continued.items[0].version, 3); assert.equal(continued.from, page.from); assert.equal(continued.to, page.to);
});

test('policy history records requesting actors and automatic lost-mode restore, excluding acknowledgements and duplicate intents', async t => {
  const f = await configurationFixture(); t.after(f.close);
  const policy = { mode: 'home_idle', interval_seconds: 600 };
  const first = await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'policy-once');
  assert.deepEqual(await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, policy, 'policy-once'), first);
  await f.reporting.acknowledge(f.device.device_id, first.command_id, f.device.device_token, { status: 'applied', applied_version: first.desired_version });
  assert.equal((await f.history.list(f.owner.user.id, f.pet.id, {})).items.length, 1);
  await f.reporting.lostMode(f.caregiver.user.id, f.device.device_id, { enabled: true, expires_in_seconds: 60 }, 'lost-start');
  await f.reporting.lostMode(f.caregiver.user.id, f.device.device_id, { enabled: true, expires_in_seconds: 60 }, 'another-enable');
  await f.reporting.lostMode(f.owner.user.id, f.device.device_id, { enabled: false }, 'lost-stop');
  await f.reporting.lostMode(f.caregiver.user.id, f.device.device_id, { enabled: true, expires_in_seconds: 60 }, 'lost-again');
  f.advance(61000); await f.reporting.expire(); await f.reporting.expire();
  const history = (await f.history.list(f.owner.user.id, f.pet.id, configurationRange)).items;
  assert.deepEqual(history.map((row: any) => row.version), [5, 4, 3, 2, 1]);
  assert.deepEqual(history.map((row: any) => row.reason), ['lost_mode_expired', 'lost_mode_started', 'lost_mode_stopped', 'lost_mode_started', 'reporting_policy_requested']);
  assert.equal(history[0].actor_kind, 'system'); assert.equal(history[0].actor_user_id, null);
  assert.equal(history[2].actor_user_id, f.owner.user.id); assert.equal(history[1].actor_user_id, f.caregiver.user.id);
  assert.deepEqual(history[0].before, { mode: 'alert', interval_seconds: 15 }); assert.deepEqual(history[0].after, policy);
  assert.equal(history[4].before_version, null); assert.equal(history[4].after_version, first.desired_version);
  for (let index = 0; index < history.length - 1; index++) assert.equal(history[index].before_version, history[index + 1].after_version);
  assert.ok(history.every((row: any) => row.command_id && row.binding_id && row.resource_id === f.device.device_id));
});

test('unbind records the actual actor and retains the old pet history after ownership and binding transfer', async t => {
  const f = await configurationFixture(); t.after(f.close);
  await f.reporting.setPolicy(f.owner.user.id, f.device.device_id, { mode: 'home_idle', interval_seconds: 600 });
  const released = await f.devices.unbind(f.owner.user.id, f.device.device_id);
  const old = (await f.history.list(f.owner.user.id, f.pet.id, {})).items;
  assert.equal(old.length, 2); assert.equal(old[0].action, 'cleared'); assert.equal(old[0].reason, 'device_unbound');
  assert.equal(old[0].actor_user_id, f.owner.user.id); assert.equal(old[0].after, null); assert.equal(old[0].after_version, null);
  await clearDeviceReporting(f.db, f.device.device_id);
  assert.equal((await f.history.list(f.owner.user.id, f.pet.id, {})).items.length, 2);
  await f.devices.release(f.owner.user.id, f.device.device_id);
  await f.devices.claim(f.stranger.user.id, { device_id: f.device.device_id, pet_id: f.otherPet.id, claim_code: released.claim_code });
  await f.reporting.setPolicy(f.stranger.user.id, f.device.device_id, { mode: 'low_power', interval_seconds: 900 });
  const fresh = (await f.history.list(f.stranger.user.id, f.otherPet.id, {})).items;
  assert.equal(fresh.length, 1); assert.equal(fresh[0].version, 1); assert.equal(fresh[0].before, null); assert.equal(fresh[0].before_version, null);
  assert.notEqual(fresh[0].binding_id, old[0].binding_id); assert.ok(fresh[0].after_version > old[1].after_version);
  assert.deepEqual((await f.history.list(f.viewer.user.id, f.pet.id, {})).items, old);
  await assert.rejects(f.history.list(f.viewer.user.id, f.otherPet.id, {}), status(404));
});

test('legacy configurations have no invented history and a failed mutation rolls back its history atomically', async t => {
  const f = await configurationFixture(); t.after(f.close);
  const id = f.db.id(), geometry = fenceInput(f.pet.id).geometry;
  await f.db.run(`INSERT INTO geofences(id,pet_id,name,geometry_json,enabled,buffer_m,accuracy_limit_m,confirm_points,created_at,updated_at,rule_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, f.pet.id, 'Legacy fence', JSON.stringify(geometry), 1, 10, 100, 2, f.db.now(), f.db.now(), 9);
  await f.db.run('INSERT INTO geofence_states(fence_id) VALUES (?)', id);
  assert.deepEqual((await f.history.list(f.owner.user.id, f.pet.id, {})).items, []);
  await f.fences.update(f.caregiver.user.id, id, { name: 'Renamed legacy fence' });
  const first = (await f.history.list(f.owner.user.id, f.pet.id, {})).items[0];
  assert.equal(first.version, 1); assert.equal(first.before_version, 9); assert.equal(first.after_version, 9); assert.equal(first.actor_user_id, f.caregiver.user.id);
  const audit = f.db.audit;
  try {
    f.db.audit = async () => { throw new Error('isolated audit failure'); };
    await assert.rejects(f.fences.update(f.owner.user.id, id, { buffer_m: 25 }), /isolated audit failure/);
  } finally { f.db.audit = audit; }
  assert.equal((await f.fences.list(f.owner.user.id, f.pet.id)).items[0].buffer_m, 10);
  assert.equal((await f.history.list(f.owner.user.id, f.pet.id, {})).items.length, 1);
  await f.fences.update(f.owner.user.id, id, { buffer_m: 25 });
  assert.deepEqual((await f.history.list(f.owner.user.id, f.pet.id, {})).items.map((row: any) => row.version), [2, 1]);
});
