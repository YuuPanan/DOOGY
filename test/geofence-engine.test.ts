import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFence, distanceMeters, evaluateFence, FenceState, Geometry, geometrySchema } from '../src/geofence-engine';

const circle: Geometry = { type: 'circle', lat: 31, lon: 121, radius_m: 100 };
const polygon: Geometry = { type: 'polygon', coordinates: [[121, 31], [121.01, 31], [121.01, 31.01], [121, 31.01]] };
const unknown: FenceState = { status: 'unknown', candidate: null, count: 0 };

test('haversine distance is symmetric and handles dateline', () => {
  assert.equal(distanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }), 0);
  const a = { lat: 0, lon: 179.999 }, b = { lat: 0, lon: -179.999 };
  assert.ok(Math.abs(distanceMeters(a, b) - 222.39) < 0.1);
  assert.equal(distanceMeters(a, b), distanceMeters(b, a));
});

test('circle detects inside, outside, and uncertain boundary buffer', () => {
  assert.equal(evaluateFence(circle, { lat: 31, lon: 121 }, 10), 'inside');
  assert.equal(evaluateFence(circle, { lat: 31.002, lon: 121 }, 10), 'outside');
  const edge = { lat: 31 + 100 / 6_371_008.8 * 180 / Math.PI, lon: 121 };
  assert.equal(evaluateFence(circle, edge), 'inside');
  assert.equal(evaluateFence(circle, edge, 10), 'uncertain');
});

test('polygon covers edge and vertex; buffer works on either side', () => {
  assert.equal(evaluateFence(polygon, { lat: 31.005, lon: 121.005 }), 'inside');
  assert.equal(evaluateFence(polygon, { lat: 31.02, lon: 121.005 }), 'outside');
  assert.equal(evaluateFence(polygon, { lat: 31, lon: 121.005 }), 'inside');
  assert.equal(evaluateFence(polygon, { lat: 31, lon: 121 }), 'inside');
  assert.equal(evaluateFence(polygon, { lat: 31.00001, lon: 121.005 }, 10), 'uncertain');
  assert.equal(evaluateFence(polygon, { lat: 30.99999, lon: 121.005 }, 10), 'uncertain');
});

test('schema accepts closed rings and rejects degenerate or self-intersecting polygons', () => {
  assert.ok(geometrySchema.safeParse(polygon).success);
  assert.ok(geometrySchema.safeParse({ ...polygon, coordinates: [...polygon.coordinates, polygon.coordinates[0]] }).success);
  for (const coordinates of [
    [[0, 0], [1, 1], [2, 2]],
    [[0, 0], [1, 0], [1, 0], [0, 1]],
    [[0, 0], [2, 2], [0, 2], [2, 0]],
    [[0, 0], [3, 0], [1, 1], [2, 0], [0, 3]],
  ]) assert.equal(geometrySchema.safeParse({ type: 'polygon', coordinates }).success, false);
  assert.equal(geometrySchema.safeParse({ type: 'circle', lat: 91, lon: 0, radius_m: 100 }).success, false);
  assert.equal(geometrySchema.safeParse({ type: 'circle', lat: 0, lon: 0, radius_m: 0 }).success, false);
});

test('first inside establishes baseline; exit and return need consecutive confirmations', () => {
  let result = advanceFence(unknown, 'inside');
  assert.equal(result.state.status, 'inside');
  assert.equal(result.transition, null);
  result = advanceFence(result.state, 'outside');
  assert.equal(result.transition, null);
  assert.equal(result.state.count, 1);
  result = advanceFence(result.state, 'outside');
  assert.equal(result.transition, 'exited');
  assert.equal(result.state.status, 'outside');
  result = advanceFence(result.state, 'outside');
  assert.equal(result.transition, null);
  result = advanceFence(result.state, 'inside');
  assert.equal(result.transition, null);
  result = advanceFence(result.state, 'inside');
  assert.equal(result.transition, 'entered');
});

test('unknown outside needs confirmation; uncertain or opposite side breaks a candidate streak', () => {
  let result = advanceFence(unknown, 'outside');
  assert.equal(result.transition, null);
  result = advanceFence(result.state, 'uncertain');
  assert.deepEqual(result.state, unknown);
  result = advanceFence(result.state, 'outside');
  assert.equal(result.transition, null);
  result = advanceFence(result.state, 'outside');
  assert.equal(result.transition, 'exited');
  result = advanceFence(result.state, 'inside');
  result = advanceFence(result.state, 'outside');
  assert.equal(result.state.candidate, null);
  assert.equal(result.transition, null);
});
