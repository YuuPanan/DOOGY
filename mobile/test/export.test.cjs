const { strict: assert } = require('node:assert');
const { createHash } = require('node:crypto');
const { test: nodeTest } = require('node:test');
const { accountExport } = require('../.test-dist/accountExport.js');
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);

const cutoff = '2026-11-24T09:00:00.000Z';
const manifest = () => ({ format: 'doogy-account-export-v1', generated_at: cutoff, user: { id: 'synthetic-user' },
  personal_sections: ['user_profile'], households: [{ id: 'synthetic-household', sections: ['pets'] }] });
const digest = async content => createHash('sha256').update(content).digest('hex');
const page = (section, household, items, next = null) => ({ section, household_id: household, generated_at: cutoff, items, next_cursor: next });

test('complete export keeps each scope and cutoff, follows cursors, and hashes every pre-complete byte', async () => {
  const requested = []; let checks = 0;
  const api = { get: async path => {
    const url = new URL(path, 'https://export-test.example.invalid'); requested.push(url);
    assert.equal(url.searchParams.get('snapshot_at'), cutoff); assert.equal(url.searchParams.get('limit'), '200');
    if (url.pathname.endsWith('/user_profile')) {
      assert.equal(url.searchParams.has('household_id'), false); return page('user_profile', null, [{ user_id: 'synthetic-user', display_name: 'Synthetic' }]);
    }
    assert.equal(url.searchParams.get('household_id'), 'synthetic-household');
    return url.searchParams.get('cursor') === 'next-pet' ? page('pets', 'synthetic-household', [{ id: 'pet-2' }])
      : page('pets', 'synthetic-household', [{ id: 'pet-1' }], 'next-pet');
  } };
  const source = manifest(), result = await accountExport(api, source, digest, () => checks++);
  const lines = result.content.trimEnd().split('\n'), records = lines.map(line => JSON.parse(line));
  assert.deepEqual(records[0], { type: 'manifest', ...source });
  assert.deepEqual(records.filter(row => row.type === 'record').map(row => ({ section: row.section, household_id: row.household_id, data: row.data })), [
    { section: 'user_profile', household_id: null, data: { user_id: 'synthetic-user', display_name: 'Synthetic' } },
    { section: 'pets', household_id: 'synthetic-household', data: { id: 'pet-1' } },
    { section: 'pets', household_id: 'synthetic-household', data: { id: 'pet-2' } },
  ]);
  const complete = records.at(-1), beforeComplete = lines.slice(0, -1).join('\n') + '\n';
  assert.equal(complete.type, 'complete'); assert.equal(complete.rows, 3); assert.equal(result.total_records, 3);
  assert.equal(complete.content_sha256, await digest(beforeComplete)); assert.ok(Number.isFinite(Date.parse(complete.completed_at)));
  assert.deepEqual(complete.counts, [{ section: 'user_profile', household_id: null, records: 1 }, { section: 'pets', household_id: 'synthetic-household', records: 2 }]);
  assert.deepEqual(result.counts, complete.counts); assert.equal(requested.length, 3); assert.ok(checks >= 7); assert.ok(result.content.endsWith('\n'));
});

for (const mismatch of ['section', 'household_id', 'generated_at', 'items', 'next_cursor']) test(`export rejects mismatched ${mismatch} without yielding a partial artifact`, async () => {
  const source = { ...manifest(), households: [] }; let artifact, digests = 0;
  const valid = page('user_profile', null, [{ user_id: 'synthetic-user' }]);
  const invalid = { ...valid, [mismatch]: { section: 'pets', household_id: 'different-household', generated_at: '2026-11-23T09:00:00.000Z', items: {}, next_cursor: undefined }[mismatch] };
  await assert.rejects(async () => { artifact = await accountExport({ get: async () => invalid }, source, async text => { digests++; return digest(text); }, () => {}); }, /导出分页不完整/);
  assert.equal(artifact, undefined); assert.equal(digests, 0);
});

test('a repeated cursor stops export instead of looping or producing a complete marker', async () => {
  const source = { ...manifest(), households: [] }; let calls = 0, artifact;
  await assert.rejects(async () => { artifact = await accountExport({ get: async () => { calls++; return page('user_profile', null, [{ id: `row-${calls}` }], 'loop'); } }, source, digest, () => {}); }, /导出分页不完整/);
  assert.equal(calls, 2); assert.equal(artifact, undefined);
});

test('a later page failure discards all previously fetched sections', async () => {
  let calls = 0, artifact, digests = 0;
  await assert.rejects(async () => { artifact = await accountExport({ get: async () => {
    if (++calls === 1) return page('user_profile', null, [{ user_id: 'synthetic-user' }]);
    throw new Error('Synthetic household access revoked');
  } }, manifest(), async text => { digests++; return digest(text); }, () => {}); }, /Synthetic household access revoked/);
  assert.equal(calls, 2); assert.equal(artifact, undefined); assert.equal(digests, 0);
});

test('authorization checks after a page prevent export of a result from a changed session', async () => {
  let allowed = true, artifact, calls = 0, digests = 0;
  await assert.rejects(async () => { artifact = await accountExport({ get: async () => {
    calls++; allowed = false; return page('user_profile', null, [{ user_id: 'previous-account' }]);
  } }, manifest(), async text => { digests++; return digest(text); }, () => { if (!allowed) throw new Error('SESSION_CHANGED'); }); }, /SESSION_CHANGED/);
  assert.equal(artifact, undefined); assert.equal(calls, 1); assert.equal(digests, 0);
});

test('a session change during final digest still prevents an export artifact', async () => {
  let allowed = true, artifact;
  const source = { ...manifest(), households: [] };
  await assert.rejects(async () => { artifact = await accountExport({ get: async () => page('user_profile', null, []) }, source,
    async text => { allowed = false; return digest(text); }, () => { if (!allowed) throw new Error('SESSION_CHANGED'); }); }, /SESSION_CHANGED/);
  assert.equal(artifact, undefined);
});
