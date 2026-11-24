import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { ContactsService, deleteHouseholdContact } from '../src/contacts';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
async function fixture() {
  let now = new Date('2026-11-24T09:00:00Z');
  const db = new Db(':memory:', () => now), identity = new IdentityService(db), contacts = new ContactsService(db);
  const owner = await identity.register({ email: 'contacts-owner@example.invalid', password: 'password123' });
  return { db, identity, contacts, owner, tick: () => { now = new Date(now.getTime() + 1000); } };
}

test('联系人保留原文电话、规范邮箱，默认未知同意与无主联系人，不伪造核验或条款', async () => {
  const f = await fixture();
  try {
    const id = f.owner.user.id, household = f.owner.household.id;
    assert.equal((await f.contacts.list(id, household, {})).primary_contact_id, null);
    const first = await f.contacts.create(id, household, { name: '  Vet office  ', phone: '  +44 (0) 20-1234 x5  ', email: 'Office@Example.com' }, 'first-contact');
    assert.equal(first.name, 'Vet office'); assert.equal(first.phone, '+44 (0) 20-1234 x5'); assert.equal(first.email, 'office@example.com');
    assert.equal(first.is_primary, false); assert.equal(first.primary_contact_id, null);
    assert.deepEqual(first.consent, { status: 'unknown', source: 'household_member_reported', verified: false, reported_by: null, reported_at: null, note: '' });
    assert.equal(first.terms_version, undefined); assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM user_consents'))!.n, 0);
    assert.deepEqual(await f.contacts.create(id, household, { name: 'Vet office', phone: '+44 (0) 20-1234 x5', email: 'office@example.com' }, 'first-contact'), first);
    await assert.rejects(f.contacts.create(id, household, { name: 'Changed', email: 'office@example.com' }, 'first-contact'), status(409));
    for (const body of [{ name: 'No method' }, { name: 'Bad phone', phone: '123\r\n456' }, { name: 'Bad phone', phone: '+++' }, { name: 'Bad email', email: 'invalid' }, { name: 'Forged', email: 'valid@example.com', consent: { status: 'reported_granted', verified: true } }]) await assert.rejects(f.contacts.create(id, household, body), ZodError);
  } finally { await f.db.close(); }
});

test('联系方式变更清除旧同意，只有同次显式报告保留新地址报告；编辑版本和幂等可核对', async () => {
  const f = await fixture();
  try {
    const user = f.owner.user.id, household = f.owner.household.id;
    const first = await f.contacts.create(user, household, { name: 'Walker', phone: '123 456', consent: { status: 'reported_granted', note: 'Household member reports permission' } });
    assert.equal(first.consent.reported_by, user); assert.equal(first.consent.reported_at, f.db.now());
    f.tick();
    const renamed = await f.contacts.update(user, first.id, { expected_version: 1, name: 'Walker renamed' });
    assert.deepEqual(renamed.consent, first.consent);
    const changed = await f.contacts.update(user, first.id, { expected_version: 2, phone: '987 654' }, 'change-phone');
    assert.equal(changed.consent.status, 'unknown'); assert.equal(changed.consent.reported_at, null); assert.equal(changed.consent.note, '');
    assert.deepEqual(await f.contacts.update(user, first.id, { expected_version: 2, phone: '987 654' }, 'change-phone'), changed);
    await assert.rejects(f.contacts.update(user, first.id, { expected_version: 2, name: 'stale' }), status(409));
    f.tick();
    const reported = await f.contacts.update(user, first.id, { expected_version: 3, phone: null, email: 'NEW@Example.com', consent: { status: 'reported_granted', note: 'New address report' } });
    assert.equal(reported.email, 'new@example.com'); assert.equal(reported.consent.status, 'reported_granted'); assert.equal(reported.consent.reported_at, f.db.now());
    const sameAddress = await f.contacts.update(user, first.id, { expected_version: 4, email: 'NEW@example.com' });
    assert.deepEqual(sameAddress.consent, reported.consent, 'case normalization alone must not reset consent');
    await assert.rejects(f.contacts.update(user, first.id, { expected_version: 5, email: null }), status(400));
    await assert.rejects(f.contacts.update(user, first.id, { expected_version: 5 }), ZodError);
    await assert.rejects(f.contacts.delete(user, first.id, { expected_version: 4 }), status(409));
  } finally { await f.db.close(); }
});

test('主联系人切换在事务中取消旧主联系人并增加版本，可邮箱主联系，删除不顺延', async () => {
  const f = await fixture();
  try {
    const user = f.owner.user.id, household = f.owner.household.id;
    const first = await f.contacts.create(user, household, { name: 'First', phone: '123456', is_primary: true });
    const second = await f.contacts.create(user, household, { name: 'Email primary', email: 'primary@example.com', is_primary: true });
    assert.equal(second.phone, null); assert.equal(second.primary_contact_id, second.id);
    const rows = await f.contacts.list(user, household, {}), old = rows.items.find((row: Row) => row.id === first.id);
    assert.equal(old.is_primary, false); assert.equal(old.version, 2); assert.equal(old.updated_by, user);
    await assert.rejects(f.contacts.update(user, first.id, { expected_version: 1, name: 'stale primary editor' }), status(409));
    const deleted = await f.contacts.delete(user, second.id, { expected_version: 1 });
    assert.equal(deleted.primary_contact_id, null); assert.equal((await f.contacts.list(user, household, {})).items[0].is_primary, false);
    const third = await f.contacts.create(user, household, { name: 'Third', phone: '987654' });
    await Promise.all([f.contacts.update(user, first.id, { expected_version: 2, is_primary: true }), f.contacts.update(user, third.id, { expected_version: 1, is_primary: true })]);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM household_contacts WHERE household_id=? AND is_primary=1', household))!.n, 1);
  } finally { await f.db.close(); }
});

test('当前家庭授权先于回执；删除清除各用户缓存、原文和恢复日志重放，不影响其他联系人', async () => {
  const f = await fixture();
  try {
    const user = f.owner.user.id, household = f.owner.household.id;
    const helper = await f.identity.register({ email: 'contacts-helper@example.invalid', password: 'password123' });
    const outsider = await f.identity.register({ email: 'contacts-outsider@example.invalid', password: 'password123' });
    const invite = await f.identity.invite(user, household, { email: helper.user.email, role: 'caregiver' }); await f.identity.accept(helper.user.id, invite.token);
    const first = await f.contacts.create(user, household, { name: 'Erase me', phone: '123456' }, 'owner-create');
    const changed = await f.contacts.update(helper.user.id, first.id, { expected_version: 1, purpose: 'Edited by helper' }, 'helper-edit');
    await assert.rejects(f.contacts.update(outsider.user.id, first.id, { expected_version: changed.version, purpose: 'other' }), status(404));
    const page = await f.contacts.list(user, household, { limit: 1 }); assert.equal(page.items.length, 1);
    await f.identity.changeMember(user, household, helper.user.id, { role: 'viewer' });
    await assert.rejects(f.contacts.update(helper.user.id, first.id, { expected_version: 1, purpose: 'Edited by helper' }, 'helper-edit'), status(403));
    await f.identity.revokeMember(user, household, helper.user.id);
    await assert.rejects(f.contacts.list(helper.user.id, household, {}), status(404));
    await assert.rejects(f.contacts.update(helper.user.id, first.id, { expected_version: 1, purpose: 'Edited by helper' }, 'helper-edit'), status(404));
    const remaining = await f.contacts.create(user, household, { name: 'Keep me', phone: '987654' });
    const deleted = await f.contacts.delete(user, first.id, { expected_version: changed.version }); assert.equal(deleted.deleted, true);
    assert.equal(await f.db.get('SELECT id FROM household_contacts WHERE id=?', first.id), undefined);
    const cached = await f.db.all('SELECT response_json FROM idempotency_keys'); assert.ok(cached.every(row => !row.response_json.includes(first.id)));
    const receipt = await f.db.get("SELECT kind,payload_json FROM privacy_deletions WHERE resource_id=? AND kind='household_contact'", first.id); assert.equal(receipt!.kind, 'household_contact'); assert.equal(receipt!.payload_json, '{}');
    assert.equal((await deleteHouseholdContact(f.db, first.id, false)).deleted, false);
    assert.equal((await f.contacts.list(user, household, {})).items[0].id, remaining.id);
    await assert.rejects(f.contacts.delete(user, first.id, { expected_version: changed.version }), status(404));
  } finally { await f.db.close(); }
});
