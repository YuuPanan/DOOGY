import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { test } from 'node:test';
import { contactAlertFixture, contactAlertBody, selectedContact } from './contact-alerts-fixture';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('notification history is family-shared and every page rechecks current pet access', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  assert.deepEqual(await f.service.list(f.owner.user.id, f.pet.id, {}), { pet_id: f.pet.id, items: [], next_cursor: null });
  const body = contactAlertBody([selectedContact(f.granted)]);
  for (let n = 0; n < 2; n++) await f.service.create(f.caregiver.user.id, f.pet.id, body);
  const first = await f.service.list(f.viewer.user.id, f.pet.id, { limit: 1 }); assert.ok(first.next_cursor);
  assert.equal(first.items[0].created_by, f.caregiver.user.id);
  await assert.rejects(f.service.create(f.viewer.user.id, f.pet.id, body), status(403));
  await assert.rejects(f.service.list(f.owner.user.id, f.pet.id, { cursor: first.next_cursor }), status(400));
  await assert.rejects(f.service.list(f.stranger.user.id, f.pet.id, {}), status(404));
  await assert.rejects(f.service.list(f.owner.user.id, f.otherPet.id, {}), status(404));
  const sameHouseholdPet = await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'Empty history pet' });
  await assert.rejects(f.service.list(f.viewer.user.id, sameHouseholdPet.id, { cursor: first.next_cursor }), status(400));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id);
  assert.equal((await f.service.list(f.owner.user.id, f.pet.id, {})).items.length, 2);
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
  await assert.rejects(f.service.list(f.viewer.user.id, f.pet.id, { cursor: first.next_cursor }), status(404));
});

test('same-millisecond keyset pages do not repeat after new inserts or reorder when an attempt changes', async t => {
  const f = await contactAlertFixture('api'); t.after(f.close);
  const body = contactAlertBody([selectedContact(f.granted)]), created = [];
  for (let n = 0; n < 4; n++) created.push(await f.service.create(f.owner.user.id, f.pet.id, body));
  const expected = created.map(row => row.id).sort().reverse();
  assert.equal(new Set(created.map(row => row.created_at)).size, 1);
  const first = await f.service.list(f.owner.user.id, f.pet.id, { limit: '1' });
  assert.equal(first.items[0].id, expected[0]); await f.service.work();
  f.advance(); const newest = await f.service.create(f.owner.user.id, f.pet.id, body);
  const old = created.find(row => row.id === expected.at(-1))!, retried = await f.service.retry(f.caregiver.user.id, old.id, { expected_attempt: 1 });
  assert.equal(retried.attempt, 2); assert.equal(retried.created_at, old.created_at); assert.notEqual(retried.updated_at, old.updated_at);
  const ids = [first.items[0].id]; let cursor = first.next_cursor;
  while (cursor) { const page = await f.service.list(f.owner.user.id, f.pet.id, { limit: 1, cursor }); ids.push(...page.items.map((row: any) => row.id)); cursor = page.next_cursor; }
  assert.deepEqual(ids, expected); assert.equal(new Set(ids).size, 4);
  const full = await f.service.list(f.owner.user.id, f.pet.id, { limit: 200 });
  assert.deepEqual(full.items.map((row: any) => row.id), [newest.id, ...expected]);
  assert.equal(full.items.find((row: any) => row.id === old.id).attempt, 2);
});

test('history accepts only the paging query and strictly validates cursor shape and encoding', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  const body = contactAlertBody([selectedContact(f.granted)]);
  await f.service.create(f.owner.user.id, f.pet.id, body); await f.service.create(f.owner.user.id, f.pet.id, body);
  const first = await f.service.list(f.owner.user.id, f.pet.id, { limit: 1 }), decoded = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString('utf8'));
  for (const query of [{ limit: 0 }, { limit: 201 }, { limit: 1.2 }, { limit: 'not-a-number' }, { limit: null }, { cursor: '' }, { cursor: [] },
    { status: 'failed' }, { from: '2026-11-24T00:00:00Z' }, { to: '2026-11-25T00:00:00Z' }, { unknown: true }]) await assert.rejects(f.service.list(f.owner.user.id, f.pet.id, query));
  for (const cursor of ['%', 'a', encode(null), encode([]), encode({}), first.next_cursor + '=', first.next_cursor + '!',
    encode({ ...decoded, created_at: 'not-a-date' }), encode({ ...decoded, id: 'not-an-id' }), encode({ ...decoded, extra: true }),
    encode({ ...decoded, user: f.viewer.user.id }), encode({ ...decoded, pet: f.otherPet.id })]) await assert.rejects(f.service.list(f.owner.user.id, f.pet.id, { cursor }));
  assert.equal((await f.service.list(f.owner.user.id, f.pet.id, { cursor: first.next_cursor })).items.length, 1);
});

test('history summaries match detail for all terminal states and expire pending exactly at the boundary', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  const granted = contactAlertBody([selectedContact(f.granted)]), unknown = contactAlertBody([selectedContact(f.unknown, 'phone')]);
  const simulated = await f.service.create(f.owner.user.id, f.pet.id, granted); await f.service.work();
  const partial = await f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted), selectedContact(f.unknown, 'phone')])); await f.service.work();
  const failed = await f.service.create(f.owner.user.id, f.pet.id, unknown); await f.service.work();
  const cancelled = await f.service.create(f.owner.user.id, f.pet.id, granted); await f.service.cancel(f.owner.user.id, cancelled.id, { expected_attempt: 1 });
  const expiring = await f.service.create(f.owner.user.id, f.pet.id, { ...granted, expires_in_seconds: 60 });
  const unchanged = (await f.service.get(f.owner.user.id, simulated.id)).updated_at;
  f.advance(59999); assert.equal((await f.service.list(f.viewer.user.id, f.pet.id, {})).items.find((row: any) => row.id === expiring.id).status, 'pending');
  f.advance(1); const page = await f.service.list(f.viewer.user.id, f.pet.id, {});
  const expected = new Map([[simulated.id, 'simulated'], [partial.id, 'partial'], [failed.id, 'failed'], [cancelled.id, 'cancelled'], [expiring.id, 'failed']]);
  for (const row of page.items) {
    const { recipients, ...detail } = await f.service.get(f.viewer.user.id, row.id); assert.deepEqual(row, detail); assert.equal(row.status, expected.get(row.id));
    assert.deepEqual(Object.keys(row).sort(), ['id', 'pet_id', 'message', 'captured_mode', 'attempt', 'created_by', 'requested_by', 'created_at', 'expires_at', 'updated_at', 'status', 'counts', 'content_scope', 'location_link_included', 'recipient_consent_verified'].sort());
    assert.equal(row.location_link_included, false); assert.equal(row.recipient_consent_verified, false); assert.equal(row.content_scope, 'message_only');
    assert.equal(recipients.length, row.counts.total);
  }
  assert.equal(page.items.find((row: any) => row.id === simulated.id).updated_at, unchanged);
  const expired = page.items.find((row: any) => row.id === expiring.id); assert.equal(expired.counts.failed, 1); assert.equal(expired.updated_at, f.db.now());
  assert.equal((await f.service.get(f.owner.user.id, expiring.id)).recipients[0].error_code, 'REQUEST_EXPIRED');
  f.advance(); const again = await f.service.list(f.owner.user.id, f.pet.id, {});
  assert.equal(again.items.find((row: any) => row.id === expiring.id).updated_at, expired.updated_at);
  for (const secret of [f.granted.email, f.unknown.phone, 'recipients', 'token', 'public_path']) assert.equal(JSON.stringify(page).includes(secret), false);
});

test('a full history page reads recipient states in one batch instead of fetching each detail', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  for (let n = 0; n < 12; n++) await f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted)]));
  const reads = t.mock.method(f.db, 'all');
  const result = await f.service.list(f.owner.user.id, f.pet.id, { limit: 12 }); assert.equal(result.items.length, 12);
  const recipientReads = reads.mock.calls.filter(call => /SELECT[\s\S]*FROM contact_alert_recipients/i.test(String(call.arguments[0])));
  assert.equal(recipientReads.length, 1);
});
