import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Row } from '../src/db';
import { PrivacyService } from '../src/privacy';
import { contactAlertBody, contactAlertFixture, selectedContact } from './contact-alerts-fixture';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;

test('主联系人自动降级同步失效旧待发送选择、记录变更marker，旧alert键不能重新排队', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  const previous = await f.contacts.update(f.owner.user.id, f.granted.id, { expected_version: f.granted.version, is_primary: true });
  const beforeMarkers = (await f.db.get("SELECT COUNT(*) AS n FROM privacy_deletions WHERE resource_id=? AND kind='household_contact_changed'", previous.id))!.n;
  const input = contactAlertBody([selectedContact({ id: previous.id, version: previous.version })]);
  const alert = await f.service.create(f.caregiver.user.id, f.pet.id, input, 'old-primary-alert');
  assert.ok(await f.db.get('SELECT key FROM idempotency_keys WHERE user_id=? AND key=?', f.caregiver.user.id, 'old-primary-alert'));
  f.advance();
  const replacement = await f.contacts.create(f.owner.user.id, f.owner.household.id, {
    name: 'New explicit primary', email: 'replacement-primary@example.invalid', is_primary: true, consent: { status: 'reported_granted' },
  });
  const contacts = await f.contacts.list(f.owner.user.id, f.owner.household.id, {});
  const demoted = contacts.items.find((row: Row) => row.id === previous.id);
  assert.equal(demoted.is_primary, false); assert.equal(demoted.version, previous.version + 1);
  assert.equal(contacts.primary_contact_id, replacement.id); assert.equal(demoted.updated_by, f.owner.user.id);
  const marker = await f.db.all("SELECT payload_json FROM privacy_deletions WHERE resource_id=? AND kind='household_contact_changed'", previous.id);
  assert.equal(marker.length, beforeMarkers + 1); assert.ok(marker.every(row => row.payload_json === '{}'));
  const stored = (await f.db.get('SELECT * FROM contact_alert_recipients WHERE id=?', alert.recipients[0].id))!;
  assert.equal(stored.status, 'failed'); assert.equal(stored.error_code, 'CONTACT_CHANGED'); assert.equal(stored.attempt, 1);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE user_id=? AND key=?', f.caregiver.user.id, 'old-primary-alert'), undefined);
  await assert.rejects(f.service.create(f.caregiver.user.id, f.pet.id, input, 'old-primary-alert'), status(409));
  await assert.rejects(f.service.retry(f.owner.user.id, alert.id, { expected_attempt: 1 }), status(409));
  assert.equal(await f.service.work(), 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM contact_alerts WHERE pet_id=?', f.pet.id))!.n, 1);
  assert.equal((await f.service.get(f.owner.user.id, alert.id)).recipients[0].status, 'failed');
});

test('合成mixed终态只重排失败收件人，已成功行及时间不变，同ID完成不重复成功', async t => {
  const f = await contactAlertFixture(); t.after(f.close);
  const second = await f.contacts.create(f.owner.user.id, f.owner.household.id, {
    name: 'Second reported recipient', phone: '+1 2025550100', consent: { status: 'reported_granted' },
  });
  const alert = await f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted), selectedContact(second, 'phone')]), 'mixed-alert');
  assert.equal(await f.service.work(), 1);
  const completed = await f.service.get(f.owner.user.id, alert.id); assert.equal(completed.status, 'simulated');
  const successful = completed.recipients.find((row: Row) => row.contact_id === f.granted.id), failed = completed.recipients.find((row: Row) => row.contact_id === second.id);
  const successfulBefore = { ...await f.db.get('SELECT * FROM contact_alert_recipients WHERE id=?', successful.id) };
  // Test-only mixed response fixture; this does not exercise or validate a real delivery provider.
  await f.db.run("UPDATE contact_alert_recipients SET status='failed',error_code='CHANNEL_NOT_CONFIGURED',execution_source=NULL WHERE id=?", failed.id);
  const mixed = await f.service.get(f.owner.user.id, alert.id);
  assert.equal(mixed.status, 'partial'); assert.deepEqual(mixed.counts, { total: 2, pending: 0, simulated: 1, failed: 1, cancelled: 0 });
  f.advance(); const retryAt = f.db.now();
  const pending = await f.service.retry(f.caregiver.user.id, alert.id, { expected_attempt: 1 }, 'mixed-retry');
  assert.equal(pending.id, alert.id); assert.equal(pending.attempt, 2); assert.equal(pending.requested_by, f.caregiver.user.id);
  assert.deepEqual(pending.counts, { total: 2, pending: 1, simulated: 1, failed: 0, cancelled: 0 });
  assert.deepEqual({ ...await f.db.get('SELECT * FROM contact_alert_recipients WHERE id=?', successful.id) }, successfulBefore);
  const requeued = { ...await f.db.get('SELECT * FROM contact_alert_recipients WHERE id=?', failed.id) };
  assert.equal(requeued.id, failed.id); assert.equal(requeued.attempt, 2); assert.equal(requeued.status, 'pending');
  assert.equal(requeued.queued_at, retryAt); assert.equal(requeued.processed_at, null); assert.equal(requeued.error_code, null);
  assert.equal((await f.service.retry(f.caregiver.user.id, alert.id, { expected_attempt: 1 }, 'mixed-retry')).attempt, 2);
  assert.deepEqual({ ...await f.db.get('SELECT * FROM contact_alert_recipients WHERE id=?', failed.id) }, requeued);
  f.advance(); const finishedAt = f.db.now();
  assert.equal(await f.service.work(), 1); assert.equal(await f.service.work(), 0);
  const final = await f.service.get(f.owner.user.id, alert.id); assert.equal(final.id, alert.id); assert.equal(final.status, 'simulated');
  assert.deepEqual(final.counts, { total: 2, pending: 0, simulated: 2, failed: 0, cancelled: 0 });
  assert.deepEqual({ ...await f.db.get('SELECT * FROM contact_alert_recipients WHERE id=?', successful.id) }, successfulBefore);
  const retried = { ...await f.db.get('SELECT * FROM contact_alert_recipients WHERE id=?', failed.id) };
  assert.equal(retried.id, failed.id); assert.equal(retried.attempt, 2); assert.equal(retried.queued_at, retryAt); assert.equal(retried.processed_at, finishedAt);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM contact_alert_recipients WHERE alert_id=?', alert.id))!.n, 2);
  const finalSnapshot = await f.db.all('SELECT * FROM contact_alert_recipients WHERE alert_id=? ORDER BY id', alert.id);
  assert.equal((await f.service.retry(f.caregiver.user.id, alert.id, { expected_attempt: 1 }, 'mixed-retry')).attempt, 2);
  await assert.rejects(f.service.retry(f.owner.user.id, alert.id, { expected_attempt: 2 }), status(409));
  assert.deepEqual(await f.db.all('SELECT * FROM contact_alert_recipients WHERE alert_id=? ORDER BY id', alert.id), finalSnapshot);
});

test('重试者注销取消待发送后，其他成员原创建键保留并返回同ID取消状态，不重新排队', async t => {
  const f = await contactAlertFixture('api'); t.after(f.close);
  const input = contactAlertBody([selectedContact(f.granted)]);
  const alert = await f.service.create(f.owner.user.id, f.pet.id, input, 'original');
  assert.equal(await f.service.work(), 1);
  assert.equal((await f.service.get(f.owner.user.id, alert.id)).recipients[0].error_code, 'CHANNEL_NOT_CONFIGURED');
  process.env.DATA_MODE = 'offline'; f.advance();
  const pending = await f.service.retry(f.caregiver.user.id, alert.id, { expected_attempt: 1 }, 'caregiver-retry');
  assert.equal(pending.status, 'pending'); assert.equal(pending.requested_by, f.caregiver.user.id);
  await new PrivacyService(f.db).closeAccount(f.caregiver.user.id, { password: 'Synthetic-contact-alert-2026', confirmation: 'DELETE' });
  const cancelled = await f.service.get(f.owner.user.id, alert.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.created_by, f.owner.user.id); assert.equal(cancelled.requested_by, null);
  assert.equal(cancelled.recipients[0].error_code, 'ACCOUNT_CLOSED');
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM idempotency_keys WHERE user_id=?', f.caregiver.user.id))!.n, 0);
  const replay = await f.service.create(f.owner.user.id, f.pet.id, input, 'original');
  assert.equal(replay.id, alert.id); assert.equal(replay.status, 'cancelled'); assert.equal(replay.attempt, 2);
  assert.ok(await f.db.get('SELECT key FROM idempotency_keys WHERE user_id=? AND key=?', f.owner.user.id, 'original'));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM contact_alerts WHERE pet_id=?', f.pet.id))!.n, 1);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM contact_alert_recipients WHERE alert_id=?', alert.id))!.n, 1);
  assert.equal(await f.service.work(), 0);
  assert.deepEqual(await f.service.get(f.owner.user.id, alert.id), cancelled);
});
