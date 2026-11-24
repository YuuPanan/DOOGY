import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { ContactsService } from '../src/contacts';
import { ContactAlertsService } from '../src/contact-alerts';
import { PrivacyService } from '../src/privacy';
import { AccountExportService } from '../src/account-export';
import { RetentionService } from '../src/retention';
import { snapshotDatabase } from '../scripts/database-snapshot';
import { openBackendFixture } from './backend-fixture';

const password = 'Synthetic-contact-alert-lifecycle', instant = Date.parse('2026-11-24T12:00:00Z');
const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
const selected = (contact: Row, method = 'email') => ({ contact_id: contact.id, expected_version: contact.version, method });
const request = (contact: Row, message = 'Shared user message', method = 'email') => ({ message, consent: true, recipients: [selected(contact, method)] });
async function seed(db: Db) {
  process.env.DATA_MODE = 'offline';
  const identity = new IdentityService(db), contacts = new ContactsService(db), alerts = new ContactAlertsService(db);
  const register = (name: string) => identity.register({ email: `contact-alert-life-${name}@example.invalid`, password, timezone: 'UTC' });
  const owner = await register('owner'), author = await register('author'), requester = await register('requester'), viewer = await register('viewer'), outsider = await register('outsider');
  for (const [user, role] of [[author, 'caregiver'], [requester, 'caregiver'], [viewer, 'viewer']] as const) {
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: user.user.email, role }); await identity.accept(user.user.id, invitation.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Contact alert life pet' });
  const otherPet = await identity.createPet(outsider.user.id, { household_id: outsider.household.id, name: 'Other household pet' });
  const contact = await contacts.create(owner.user.id, owner.household.id, { name: 'Synthetic recipient', phone: '+44 (0) 20-1234', email: 'synthetic-recipient@example.invalid', consent: { status: 'reported_granted', note: 'Synthetic report only' } });
  const otherContact = await contacts.create(outsider.user.id, outsider.household.id, { name: 'Unrelated recipient', email: 'other-recipient@example.invalid', consent: { status: 'reported_granted' } });
  return { db, identity, contacts, alerts, owner, author, requester, viewer, outsider, pet, otherPet, contact, otherContact,
    privacy: new PrivacyService(db), exporter: new AccountExportService(db), retention: new RetentionService(db) };
}
async function fixture() {
  let now = instant;
  const backend = await openBackendFixture(() => new Date(now));
  return { ...await seed(backend.db), close: backend.close, advance: (ms: number) => { now += ms; } };
}
async function cached(db: Db, user: string, key: string) {
  return db.get('SELECT key FROM idempotency_keys WHERE user_id=? AND key=?', user, key);
}
function files() {
  const folder = mkdtempSync(resolve(tmpdir(), 'doogy-contact-alert-backup-'));
  const paths = ['source', 'snapshot', 'restored', 'current-snapshot', 'current-restored'].map(name => resolve(folder, name + '.db'));
  return { paths, cleanup: () => {
    for (const path of paths) for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(path + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    rmdirSync(folder);
  } };
}

test('联系人通知按当前家庭授权导出两分区，不动态复制地址；撤权后旧请求键及导出不可访问', async t => {
  const f = await fixture(); t.after(f.close);
  const body = request(f.contact), alert = await f.alerts.create(f.author.user.id, f.pet.id, body, 'author-create');
  const query = { household_id: f.owner.household.id };
  const parent = await f.exporter.page(f.viewer.user.id, 'contact_alerts', query), children = await f.exporter.page(f.viewer.user.id, 'contact_alert_recipients', query);
  assert.equal(parent.items[0].id, alert.id); assert.equal(parent.items[0].message, body.message);
  assert.equal(children.items[0].contact_id, f.contact.id); assert.equal(children.items[0].contact_version, f.contact.version); assert.equal(children.items[0].method, 'email');
  for (const row of [...parent.items, ...children.items]) for (const field of ['phone','email','address','token','token_hash','share_token','share_url']) assert.equal(Object.hasOwn(row, field), false, field);
  await assert.rejects(f.exporter.page(f.outsider.user.id, 'contact_alerts', query), status(404));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.author.user.id);
  await assert.rejects(f.alerts.create(f.author.user.id, f.pet.id, body, 'author-create'), status(404));
  await assert.rejects(f.alerts.get(f.author.user.id, alert.id), status(404));
  await assert.rejects(f.exporter.page(f.author.user.id, 'contact_alerts', query), status(404));
  await assert.rejects(f.exporter.page(f.author.user.id, 'contact_alert_recipients', query), status(404));
  await f.alerts.work();
  const failed = await f.alerts.get(f.owner.user.id, alert.id); assert.equal(failed.status, 'failed'); assert.equal(failed.recipients[0].error_code, 'ACCESS_REVOKED');
});

test('注销只取消当前requested_by的pending；原作者关闭不取消他人重试，终态与共享原文保留', async t => {
  const f = await fixture(); t.after(f.close);
  const terminal = await f.alerts.create(f.author.user.id, f.pet.id, request(f.contact, 'Shared terminal message'), 'terminal');
  await f.alerts.work(); assert.equal((await f.alerts.get(f.owner.user.id, terminal.id)).status, 'simulated');
  process.env.DATA_MODE = 'api';
  const handedOff = await f.alerts.create(f.author.user.id, f.pet.id, request(f.contact, 'Original author message, other current requester'), 'handed-off');
  await f.alerts.work();
  assert.equal((await f.alerts.get(f.owner.user.id, handedOff.id)).recipients[0].error_code, 'CHANNEL_NOT_CONFIGURED');
  process.env.DATA_MODE = 'offline';
  await f.alerts.retry(f.requester.user.id, handedOff.id, { expected_attempt: 1 }, 'requester-retry');
  const authorPending = await f.alerts.create(f.author.user.id, f.pet.id, request(f.contact, 'Closing requester pending message'), 'author-pending');
  await f.privacy.closeAccount(f.author.user.id, { password, confirmation: 'DELETE' });
  const current = await f.alerts.get(f.owner.user.id, handedOff.id); assert.equal(current.created_by, null); assert.equal(current.requested_by, f.requester.user.id); assert.equal(current.status, 'pending');
  const cancelled = await f.alerts.get(f.owner.user.id, authorPending.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.recipients[0].error_code, 'ACCOUNT_CLOSED');
  assert.equal(cancelled.message, 'Closing requester pending message'); assert.equal(cancelled.created_by, null); assert.equal(cancelled.requested_by, null);
  const historical = await f.alerts.get(f.owner.user.id, terminal.id); assert.equal(historical.status, 'simulated'); assert.equal(historical.recipients[0].execution_source, 'offline_demo'); assert.equal(historical.message, 'Shared terminal message');
  await f.alerts.work(); assert.equal((await f.alerts.get(f.owner.user.id, handedOff.id)).status, 'simulated');
  process.env.DATA_MODE = 'api';
  const ownerOriginal = await f.alerts.create(f.owner.user.id, f.pet.id, request(f.contact, 'Owner text, closing retry actor'), 'owner-original'); await f.alerts.work();
  process.env.DATA_MODE = 'offline';
  await f.alerts.retry(f.requester.user.id, ownerOriginal.id, { expected_attempt: 1 }, 'closing-retry');
  assert.ok(await cached(f.db, f.owner.user.id, 'owner-original'));
  await f.privacy.closeAccount(f.requester.user.id, { password, confirmation: 'DELETE' });
  const stopped = await f.alerts.get(f.owner.user.id, ownerOriginal.id); assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.created_by, f.owner.user.id); assert.equal(stopped.requested_by, null);
  assert.equal(stopped.message, 'Owner text, closing retry actor'); assert.ok(await cached(f.db, f.owner.user.id, 'owner-original'));
  assert.equal((await f.alerts.get(f.owner.user.id, handedOff.id)).status, 'simulated');
});

test('保留预览和执行保留联系人通知历史，不暗中运行pending expiry', async t => {
  const f = await fixture(); t.after(f.close);
  const alert = await f.alerts.create(f.owner.user.id, f.pet.id, { ...request(f.contact, 'Retained request'), expires_in_seconds: 60 }, 'retention');
  await f.retention.update(f.owner.user.id, f.owner.household.id, { enabled: true, activity_days: 7, password });
  f.advance(60000);
  const before = await f.db.all('SELECT * FROM contact_alert_recipients WHERE alert_id=?', alert.id);
  const preview = (await f.retention.preview(f.owner.user.id, f.owner.household.id)).households[0];
  assert.equal(preview.retained_related_counts.contact_alerts, 1); assert.equal(preview.retained_related_counts.contact_alert_recipients, 1);
  assert.deepEqual(await f.db.all('SELECT * FROM contact_alert_recipients WHERE alert_id=?', alert.id), before);
  await f.retention.execute(f.owner.user.id, f.owner.household.id, { password });
  assert.deepEqual(await f.db.all('SELECT * FROM contact_alert_recipients WHERE alert_id=?', alert.id), before);
  assert.equal((await f.db.get('SELECT message FROM contact_alerts WHERE id=?', alert.id))!.message, 'Retained request');
});

test('删宠先清两表仅ID回执再级联，删家庭清其余通知且不影响另一家庭', async t => {
  const f = await fixture(); t.after(f.close);
  const alert = await f.alerts.create(f.author.user.id, f.pet.id, request(f.contact), 'pet-alert');
  await f.db.idempotent(f.viewer.user.id, 'test recipient copy', 'recipient-copy', {}, async () => ({ id: alert.recipients[0].id }));
  const otherAlert = await f.alerts.create(f.outsider.user.id, f.otherPet.id, request(f.otherContact), 'other-alert');
  const siblingPet = await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'Sibling pet' });
  const sibling = await f.alerts.create(f.owner.user.id, siblingPet.id, request(f.contact), 'sibling-alert');
  const preview = await f.privacy.petPreview(f.owner.user.id, f.pet.id); assert.equal(preview.related_counts.contact_alerts, 1); assert.equal(preview.related_counts.contact_alert_recipients, 1);
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  assert.equal(await f.db.get('SELECT id FROM contact_alerts WHERE id=?', alert.id), undefined);
  assert.equal(await f.db.get('SELECT id FROM contact_alert_recipients WHERE alert_id=?', alert.id), undefined);
  assert.equal(await cached(f.db, f.author.user.id, 'pet-alert'), undefined); assert.equal(await cached(f.db, f.viewer.user.id, 'recipient-copy'), undefined);
  assert.ok(await f.db.get('SELECT id FROM contact_alerts WHERE id=?', sibling.id));
  await f.privacy.deleteHousehold(f.owner.user.id, f.owner.household.id, { password, confirmation: f.owner.household.id });
  assert.equal(await f.db.get('SELECT id FROM contact_alerts WHERE id=?', sibling.id), undefined); assert.equal(await cached(f.db, f.owner.user.id, 'sibling-alert'), undefined);
  assert.ok(await f.db.get('SELECT id FROM contact_alerts WHERE id=?', otherAlert.id)); assert.ok(await cached(f.db, f.outsider.user.id, 'other-alert'));
});

test('真实SQLite删除日志恢复：旧联系人选择和回执不复活，已模拟历史保留且不谎改成未发送', async () => {
  const { paths: [source, snapshot, restored], cleanup } = files();
  const db = new Db(source, () => new Date(instant)); let recovered: Db | undefined;
  try {
    const f = await seed(db), terminal = await f.alerts.create(f.owner.user.id, f.pet.id, request(f.contact, 'Historical simulation'), 'simulated');
    await f.alerts.work();
    const queued = await f.alerts.create(f.author.user.id, f.pet.id, request(f.contact, 'Old queued message'), 'queued');
    await snapshotDatabase(source, snapshot); const archive = createHash('sha256').update(readFileSync(snapshot)).digest('hex');
    await f.contacts.delete(f.owner.user.id, f.contact.id, { expected_version: 1 });
    const receipts = await f.privacy.receipts(); assert.ok(receipts.some(row => row.kind === 'household_contact' && row.resource_id === f.contact.id));
    await snapshotDatabase(snapshot, restored); recovered = new Db(restored, () => new Date(instant));
    const privacy = new PrivacyService(recovered), alerts = new ContactAlertsService(recovered);
    assert.equal((await alerts.get(f.owner.user.id, queued.id)).status, 'pending');
    await privacy.replay(receipts);
    assert.equal(await recovered.get('SELECT id FROM household_contacts WHERE id=?', f.contact.id), undefined);
    const stopped = await alerts.get(f.owner.user.id, queued.id); assert.equal(stopped.status, 'failed'); assert.equal(stopped.recipients[0].error_code, 'CONTACT_DELETED'); assert.equal(stopped.recipients[0].contact_id, null);
    assert.equal(await cached(recovered, f.author.user.id, 'queued'), undefined);
    const history = await alerts.get(f.owner.user.id, terminal.id); assert.equal(history.status, 'simulated'); assert.equal(history.recipients[0].execution_source, 'offline_demo'); assert.equal(history.recipients[0].contact_id, null);
    assert.equal(await alerts.work(), 0); await assert.rejects(alerts.retry(f.owner.user.id, queued.id, { expected_attempt: 1 }), status(409));
    assert.equal((await privacy.replay(receipts)).applied, 0); assert.equal(createHash('sha256').update(readFileSync(snapshot)).digest('hex'), archive);
  } finally { if (recovered) await recovered.close(); await db.close(); cleanup(); }
});

test('真实SQLite变更marker恢复：旧版本和同意须重新确认，已含marker新快照跳过且不改当前资料', async () => {
  const { paths: [source, snapshot, restored, currentSnapshot, currentRestored], cleanup } = files();
  const db = new Db(source, () => new Date(instant)); let oldDb: Db | undefined, currentDb: Db | undefined;
  try {
    const f = await seed(db), terminal = await f.alerts.create(f.owner.user.id, f.pet.id, request(f.contact, 'Previous simulation', 'phone'), 'historical'); await f.alerts.work();
    const body = request(f.contact, 'Old source selection', 'phone'), queued = await f.alerts.create(f.owner.user.id, f.pet.id, body, 'old-source');
    await snapshotDatabase(source, snapshot);
    const changed = await f.contacts.update(f.owner.user.id, f.contact.id, { expected_version: 1, phone: '+44 (0) 20-9876', consent: { status: 'reported_revoked', note: 'Revoke previous destination' } });
    const receipts = await f.privacy.receipts(), marker = receipts.find(row => row.kind === 'household_contact_changed' && row.resource_id === f.contact.id);
    assert.ok(marker); assert.equal(Object.hasOwn(marker, 'payload'), false);
    assert.equal(JSON.stringify(receipts).includes(f.contact.phone), false); assert.equal(JSON.stringify(receipts).includes(changed.phone), false);
    await snapshotDatabase(source, currentSnapshot); await snapshotDatabase(snapshot, restored); await snapshotDatabase(currentSnapshot, currentRestored);
    oldDb = new Db(restored, () => new Date(instant)); currentDb = new Db(currentRestored, () => new Date(instant));
    const oldPrivacy = new PrivacyService(oldDb), oldAlerts = new ContactAlertsService(oldDb), oldContacts = new ContactsService(oldDb);
    assert.equal((await oldDb.get('SELECT consent_status FROM household_contacts WHERE id=?', f.contact.id))!.consent_status, 'reported_granted');
    assert.equal((await oldAlerts.get(f.owner.user.id, queued.id)).status, 'pending');
    await oldPrivacy.replay(receipts);
    const contact = (await oldContacts.list(f.owner.user.id, f.owner.household.id, {})).items.find((row: Row) => row.id === f.contact.id);
    assert.equal(contact.version, 2); assert.equal(contact.consent.status, 'unknown'); assert.equal(contact.consent.reported_by, null); assert.equal(contact.consent.reported_at, null); assert.equal(contact.consent.note, '');
    assert.equal(contact.phone, f.contact.phone, 'replay blocks old consent without pretending to restore the edited address');
    assert.equal((await oldAlerts.get(f.owner.user.id, queued.id)).recipients[0].error_code, 'CONTACT_CHANGED');
    assert.equal(await cached(oldDb, f.owner.user.id, 'old-source'), undefined);
    await assert.rejects(oldAlerts.create(f.owner.user.id, f.pet.id, body, 'old-source'), status(409));
    await assert.rejects(oldAlerts.retry(f.owner.user.id, queued.id, { expected_attempt: 1 }), status(409));
    const withoutConsent = await oldAlerts.create(f.owner.user.id, f.pet.id, request(contact, 'New choice still needs a report', 'phone')); await oldAlerts.work();
    assert.equal((await oldAlerts.get(f.owner.user.id, withoutConsent.id)).recipients[0].error_code, 'RECIPIENT_CONSENT_REQUIRED');
    const confirmed = await oldContacts.update(f.owner.user.id, contact.id, { expected_version: 2, consent: { status: 'reported_granted', note: 'Explicit new report after restore' } });
    const fresh = await oldAlerts.create(f.owner.user.id, f.pet.id, request(confirmed, 'New confirmed choice', 'phone')); await oldAlerts.work();
    assert.equal((await oldAlerts.get(f.owner.user.id, fresh.id)).status, 'simulated');
    assert.equal((await oldAlerts.get(f.owner.user.id, terminal.id)).status, 'simulated');
    assert.equal((await oldPrivacy.replay(receipts)).applied, 0);
    const before = { ...await currentDb.get('SELECT * FROM household_contacts WHERE id=?', f.contact.id) };
    assert.equal((await new PrivacyService(currentDb).replay(receipts)).applied, 0);
    assert.deepEqual({ ...await currentDb.get('SELECT * FROM household_contacts WHERE id=?', f.contact.id) }, before);
  } finally { if (oldDb) await oldDb.close(); if (currentDb) await currentDb.close(); await db.close(); cleanup(); }
});
