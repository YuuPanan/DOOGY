const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const { loadSafetyRange } = require('../.test-dist/safetyHistory.js');

test('all-history does not request or invent a date window', async () => {
  const range = await loadSafetyRange({ get: () => { throw new Error('unexpected HTTP'); } }, 'pet', 'all', 'UTC');
  assert.equal(range.from, null); assert.equal(range.to, null);
});
test('today keeps the actual backend 23-hour DST boundary without using the phone clock', async () => {
  const value = { pet_id: 'pet', timezone: 'America/New_York', local_date: '2026-03-08', period_start: '2026-03-08T05:00:00.000Z', period_end: '2026-03-09T04:00:00.000Z' };
  const range = await loadSafetyRange({ get: async path => { assert.match(path, /activity\/daily\?timezone=America%2FNew_York$/); return value; } }, 'pet', 'today', value.timezone);
  assert.equal(range.from, value.period_start); assert.equal(range.to, value.period_end); assert.equal(range.from_date, '2026-03-08');
  assert.equal((Date.parse(range.to) - Date.parse(range.from)) / 3600000, 23);
});
test('the seven-natural-day period uses the first and last backend days and remains frozen', async () => {
  const days = Array.from({ length: 7 }, (_, i) => ({ local_date: `2026-11-${String(i + 1).padStart(2, '0')}`, period_start: `2026-11-${String(i + 1).padStart(2, '0')}T${i ? '05' : '04'}:00:00.000Z`, period_end: `2026-11-${String(i + 2).padStart(2, '0')}T05:00:00.000Z` }));
  const value = { pet_id: 'pet', timezone: 'America/New_York', days };
  const range = await loadSafetyRange({ get: async path => { assert.match(path, /activity\/weekly/); return value; } }, 'pet', 'week', value.timezone);
  assert.equal(range.from, days[0].period_start); assert.equal(range.to, days[6].period_end); assert.equal((Date.parse(range.to) - Date.parse(range.from)) / 3600000, 169);
  days[0].period_start = '2099-01-01T00:00:00Z'; assert.equal(range.from, '2026-11-01T04:00:00.000Z');
});
test('wrong scope or incomplete/malformed date responses do not replace the current window', async () => {
  const valid = { pet_id: 'pet', timezone: 'UTC', local_date: '2026-11-24', period_start: '2026-11-24T00:00:00Z', period_end: '2026-11-25T00:00:00Z' };
  for (const value of [{ ...valid, pet_id: 'other' }, { ...valid, timezone: 'Asia/Shanghai' }, { ...valid, period_start: 'not-time' }, { ...valid, period_end: valid.period_start }])
    await assert.rejects(loadSafetyRange({ get: async () => value }, 'pet', 'today', 'UTC'));
  await assert.rejects(loadSafetyRange({ get: async () => ({ pet_id: 'pet', timezone: 'UTC', days: [valid] }) }, 'pet', 'week', 'UTC'));
});
