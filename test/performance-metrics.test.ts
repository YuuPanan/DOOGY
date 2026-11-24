import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { latencyStats } from '../scripts/postgres-performance';

test('性能统计使用nearest-rank分位数，空样本不伪装为零延迟，也不修改原样本', () => {
  const samples = Array.from({ length: 100 }, (_, index) => 100 - index);
  assert.deepEqual(latencyStats(samples), { count: 100, p50_ms: 50, p95_ms: 95, p99_ms: 99, max_ms: 100 });
  assert.equal(samples[0], 100);
  assert.deepEqual(latencyStats([]), { count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null });
  assert.equal(latencyStats([12.345]).p95_ms, 12.35);
});
