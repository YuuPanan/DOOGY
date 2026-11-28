const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const { trajectoryLayout } = require('../.test-dist/trajectory.js');

const point = (index, extra = {}) => ({ id: `point-${index}`, device_ts: `2026-11-24T12:00:0${index}.000Z`,
  lat: 31.23, lon: 121.47 + index * 0.001, source: 'gnss', accuracy_m: 10, quality_flags: [], device_id: 'device-A', binding_id: 'binding-A', ...extra });

test('an empty trajectory yields no points or segments', () => {
  assert.deepEqual(trajectoryLayout([]), { points: [], segments: [] });
});

test('sampling time and id determine chronological segments without changing input order', () => {
  const samples = [point(2), point(0), point(1)], original = samples.map(row => ({ ...row }));
  const result = trajectoryLayout(samples, 400, 200);
  assert.deepEqual(result.points.map(row => row.id), ['point-0', 'point-1', 'point-2']);
  assert.deepEqual(result.segments, [{ from: 0, to: 1 }, { from: 1, to: 2 }]);
  assert.ok(result.points[0].x < result.points[1].x && result.points[1].x < result.points[2].x);
  assert.deepEqual(samples, original);
  const tied = trajectoryLayout([point(1, { id: 'b' }), point(1, { id: 'a' })]);
  assert.deepEqual(tied.points.map(row => row.id), ['a', 'b']);
});

test('bad intermediate points break the path instead of bridging surrounding good samples', () => {
  for (const invalid of [{ source: 'wifi' }, { accuracy_m: 101 }, { accuracy_m: null }, { accuracy_m: undefined },
    { quality_flags: ['clock_ahead'] }, { lat: NaN }, { lon: Infinity }]) {
    const result = trajectoryLayout([point(2), point(1, invalid), point(0)]);
    assert.deepEqual(result.points.map(row => row.id), ['point-0', 'point-2']);
    assert.deepEqual(result.segments, []);
  }
});

test('different or unknown device and binding ownership stays disconnected', () => {
  const result = trajectoryLayout([
    point(0), point(1), point(2, { binding_id: 'binding-B' }), point(3, { binding_id: 'binding-B' }),
    point(4, { binding_id: null }), point(5), point(6, { device_id: 'device-B' }), point(7, { device_id: undefined }), point(8),
  ]);
  assert.equal(result.points.length, 9);
  assert.deepEqual(result.segments, [{ from: 0, to: 1 }, { from: 2, to: 3 }]);
  assert.deepEqual(trajectoryLayout([point(0, { binding_id: undefined }), point(1, { binding_id: undefined })]).segments, []);
});

test('single and coincident samples stay centered with finite normalized coordinates', () => {
  const single = trajectoryLayout([point(0)]);
  assert.equal(single.points[0].x, 0.5); assert.equal(single.points[0].y, 0.5); assert.deepEqual(single.segments, []);
  const same = trajectoryLayout([point(0), point(1, { lon: 121.47 })], 600, 200);
  assert.ok(same.points.every(row => row.x === 0.5 && row.y === 0.5)); assert.equal(same.segments.length, 1);
});

test('north is up and valid historical samples remain visible even when currently stale', () => {
  const result = trajectoryLayout([point(0, { lat: 30, lon: 120, freshness: 'stale', usable_for_tracking: false, accuracy_m: 100 }),
    point(1, { lat: 31, lon: 121, quality_flags: undefined })], 360, 200);
  assert.equal(result.points.length, 2); assert.equal(result.segments.length, 1);
  assert.ok(result.points[1].x > result.points[0].x); assert.ok(result.points[1].y < result.points[0].y);
  assert.ok(result.points.every(row => Number.isFinite(row.x) && Number.isFinite(row.y) && row.x >= 0 && row.x <= 1 && row.y >= 0 && row.y <= 1));
});
