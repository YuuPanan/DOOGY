import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { AccountExportService } from '../src/account-export';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { PasswordRecoveryService } from '../src/password-recovery';
import { deletionReceipt, PrivacyService } from '../src/privacy';
import { snapshotDatabase } from '../scripts/database-snapshot';
import { openBackendFixture } from './backend-fixture';

const oldPassword = 'Synthetic-old-password-2026', newPassword = 'Synthetic-reset-password-2026';
const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
const emailHash = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

async function fixture() {
  process.env.DATA_MODE = 'offline';
  const backend = await openBackendFixture(() => new Date('2026-11-24T12:00:00.000Z')), db = backend.db;
  const identity = new IdentityService(db), recovery = new PasswordRecoveryService(db), privacy = new PrivacyService(db);
  const owner = await identity.register({ email: 'recovery-lifecycle-owner@example.invalid', password: oldPassword });
  const outsider = await identity.register({ email: 'recovery-lifecycle-outsider@example.invalid', password: oldPassword });
  return { ...backend, db, identity, recovery, privacy, owner, outsider, exporter: new AccountExportService(db) };
}

test('recovery export exposes only the current user request metadata, never verification hashes or failure counters', async t => {
  const f = await fixture(); t.after(f.close);
  const first = await f.recovery.request({ email: f.owner.user.email });
  const delivery = await f.recovery.deliver(first.request_id); assert.equal(typeof delivery.token, 'string');
  await f.recovery.request({ email: f.owner.user.email });
  const other = await f.recovery.request({ email: f.outsider.user.email });
  await f.recovery.request({ email: 'unknown-recovery-lifecycle@example.invalid' });
  await f.db.run('UPDATE password_recovery_requests SET failed_attempts=3 WHERE id=?', first.request_id);
  const manifest = await f.exporter.manifest(f.owner.user.id); assert.ok(manifest.personal_sections.includes('password_recovery_requests'));
  const expectedKeys = ['id','user_id','captured_mode','delivery_status','created_at','expires_at','delivered_at','verified_at','consumed_at','invalidated_at','updated_at'].sort();
  const page = await f.exporter.page(f.owner.user.id, 'password_recovery_requests', {}); assert.equal(page.items.length, 2);
  for (const row of page.items) { assert.deepEqual(Object.keys(row).sort(), expectedKeys); assert.equal(row.user_id, f.owner.user.id); }
  const secret = (await f.db.get('SELECT token_hash,email_hash FROM password_recovery_requests WHERE id=?', first.request_id))!;
  const exported = JSON.stringify(page);
  assert.equal(exported.includes(delivery.token), false); assert.equal(exported.includes(secret.email_hash), false);
  if (secret.token_hash) assert.equal(exported.includes(secret.token_hash), false);
  const otherPage = await f.exporter.page(f.outsider.user.id, 'password_recovery_requests', {});
  assert.deepEqual(otherPage.items.map((row: any) => row.id), [other.request_id]);
  await assert.rejects(f.exporter.page(f.owner.user.id, 'password_recovery_requests', { household_id: f.owner.household.id }), status(400));
});

test('account closure removes owned and same-email requests plus only its recovery throttle state', async t => {
  const f = await fixture(); t.after(f.close);
  const ownedRequest = await f.recovery.request({ email: f.owner.user.email });
  await f.recovery.deliver(ownedRequest.request_id);
  const otherRequest = await f.recovery.request({ email: f.outsider.user.email });
  const ownerHash = emailHash(f.owner.user.email), strangerHash = emailHash(f.outsider.user.email);
  assert.ok(await f.db.get('SELECT key FROM auth_attempts WHERE key=?', `password-recovery:email:${ownerHash}`));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id IS NULL AND resource_id=?', ownedRequest.request_id))!.n, 2);
  await f.db.idempotent(f.outsider.user.id, 'recovery-metadata-copy', 'own-request-reference', {}, () => ({ request_id: ownedRequest.request_id }));
  await f.db.run('UPDATE password_recovery_requests SET user_id=NULL WHERE user_id=?', f.owner.user.id);
  await f.privacy.closeAccount(f.owner.user.id, { password: oldPassword, confirmation: 'DELETE' });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM password_recovery_requests WHERE user_id=? OR email_hash=?', f.owner.user.id, ownerHash))!.n, 0);
  assert.equal(await f.db.get('SELECT key FROM auth_attempts WHERE key=?', `password-recovery:email:${ownerHash}`), undefined);
  assert.ok(await f.db.get('SELECT id FROM password_recovery_requests WHERE user_id=?', f.outsider.user.id));
  assert.ok(await f.db.get('SELECT key FROM auth_attempts WHERE key=?', `password-recovery:email:${strangerHash}`));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM audit_logs WHERE resource_id=?', ownedRequest.request_id))!.n, 0);
  assert.ok(await f.db.get('SELECT id FROM audit_logs WHERE resource_id=?', otherRequest.request_id));
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE key=?', 'own-request-reference'), undefined);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', f.owner.user.id))!.n, 0);
  await assert.rejects(f.exporter.page(f.owner.user.id, 'password_recovery_requests', {}), status(401));
});

test('reset replay revokes only its target, is idempotent and cannot revive a closed account or accept a payload', async t => {
  const f = await fixture(); t.after(f.close);
  await f.recovery.request({ email: f.owner.user.email }); await f.recovery.request({ email: f.outsider.user.email });
  const receipt = { id: f.db.id(), kind: 'password_reset', resource_id: f.owner.user.id, deleted_at: f.db.now() };
  const outsiderHash = (await f.db.get('SELECT password_hash FROM users WHERE id=?', f.outsider.user.id))!.password_hash;
  await assert.rejects(async () => deletionReceipt.parse({ ...receipt, payload: { previous_owner_user_id: f.owner.user.id, new_owner_user_id: f.outsider.user.id, device_ids: [] } }));
  assert.equal((await f.privacy.replay([receipt])).applied, 1);
  await assert.rejects(f.identity.login({ email: f.owner.user.email, password: oldPassword }), status(401));
  await assert.rejects(f.identity.userFromAccess(f.owner.access_token), status(401));
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM password_recovery_requests WHERE user_id=?', f.owner.user.id))!.n, 0);
  const randomized = (await f.db.get('SELECT password_hash FROM users WHERE id=?', f.owner.user.id))!.password_hash;
  assert.equal((await f.privacy.replay([receipt])).applied, 0);
  assert.equal((await f.db.get('SELECT password_hash FROM users WHERE id=?', f.owner.user.id))!.password_hash, randomized);
  assert.equal((await f.db.get('SELECT password_hash FROM users WHERE id=?', f.outsider.user.id))!.password_hash, outsiderHash);
  assert.equal(await f.identity.userFromAccess(f.outsider.access_token), f.outsider.user.id);
  await f.privacy.closeAccount(f.outsider.user.id, { password: oldPassword, confirmation: 'DELETE' });
  await f.privacy.replay([{ id: f.db.id(), kind: 'password_reset', resource_id: f.outsider.user.id, deleted_at: f.db.now() }]);
  const closed = (await f.db.get('SELECT password_hash,closed_at FROM users WHERE id=?', f.outsider.user.id))!;
  assert.ok(closed.closed_at); assert.equal(closed.password_hash, '');
});

test('real SQLite pre-reset restore blocks old password, token and sessions; receipt-bearing snapshots preserve the new password', async () => {
  process.env.DATA_MODE = 'offline';
  const folder = mkdtempSync(resolve(tmpdir(), 'doogy-reset-restore-'));
  const files = ['source','before-reset','after-reset','old-restored','new-restored'].map(name => resolve(folder, `${name}.db`));
  const db = new Db(files[0], () => new Date('2026-11-24T12:00:00.000Z'));
  let oldRestored: Db | undefined, newRestored: Db | undefined;
  try {
    const identity = new IdentityService(db), recovery = new PasswordRecoveryService(db), privacy = new PrivacyService(db);
    const account = await identity.register({ email: 'password-reset-backup@example.invalid', password: oldPassword });
    const request = await recovery.request({ email: account.user.email }), delivered = await recovery.deliver(request.request_id);
    assert.equal(typeof delivered.token, 'string');
    assert.equal((await snapshotDatabase(files[0], files[1])).integrity, 'ok');
    const archiveHash = createHash('sha256').update(readFileSync(files[1])).digest('hex');
    await recovery.reset({ request_id: request.request_id, token: delivered.token, new_password: newPassword });
    const receipts = (await privacy.receipts()).filter(row => row.kind === 'password_reset'); assert.equal(receipts.length, 1);
    assert.deepEqual(Object.keys(receipts[0]).sort(), ['id','kind','resource_id','deleted_at'].sort());
    const receiptText = JSON.stringify(receipts); assert.equal(receiptText.includes(newPassword), false); assert.equal(receiptText.includes(delivered.token), false);
    assert.deepEqual(JSON.parse((await db.get('SELECT payload_json FROM privacy_deletions WHERE id=?', receipts[0].id))!.payload_json), {});
    const newSession = await identity.login({ email: account.user.email, password: newPassword });
    await snapshotDatabase(files[0], files[2]);
    await snapshotDatabase(files[1], files[3]); oldRestored = new Db(files[3], db.clock);
    const oldIdentity = new IdentityService(oldRestored), oldRecovery = new PasswordRecoveryService(oldRestored), oldPrivacy = new PrivacyService(oldRestored);
    assert.equal(await oldIdentity.userFromAccess(account.access_token), account.user.id);
    assert.equal((await oldPrivacy.replay(receipts)).applied, 1);
    await assert.rejects(oldIdentity.login({ email: account.user.email, password: oldPassword }), status(401));
    await assert.rejects(oldIdentity.login({ email: account.user.email, password: newPassword }), status(401));
    await assert.rejects(oldIdentity.userFromAccess(account.access_token), status(401));
    await assert.rejects(oldIdentity.refresh({ refresh_token: account.refresh_token }), status(401));
    await assert.rejects(oldRecovery.reset({ request_id: request.request_id, token: delivered.token, new_password: 'Do-not-restore-old-token-2026' }));
    assert.equal((await oldRestored.get('SELECT COUNT(*) AS n FROM password_recovery_requests WHERE user_id=?', account.user.id))!.n, 0);
    const fresh = await oldRecovery.request({ email: account.user.email }), freshDelivery = await oldRecovery.deliver(fresh.request_id), freshPassword = 'Synthetic-fresh-after-restore-2026';
    await oldRecovery.reset({ request_id: fresh.request_id, token: freshDelivery.token, new_password: freshPassword });
    const freshHash = (await oldRestored.get('SELECT password_hash FROM users WHERE id=?', account.user.id))!.password_hash;
    assert.equal((await oldPrivacy.replay(receipts)).applied, 0);
    assert.equal((await oldRestored.get('SELECT password_hash FROM users WHERE id=?', account.user.id))!.password_hash, freshHash);
    assert.ok((await oldIdentity.login({ email: account.user.email, password: freshPassword })).access_token);
    await snapshotDatabase(files[2], files[4]); newRestored = new Db(files[4], db.clock);
    const retainedHash = (await newRestored.get('SELECT password_hash FROM users WHERE id=?', account.user.id))!.password_hash;
    assert.equal((await new PrivacyService(newRestored).replay(receipts)).applied, 0);
    assert.equal((await newRestored.get('SELECT password_hash FROM users WHERE id=?', account.user.id))!.password_hash, retainedHash);
    const newIdentity = new IdentityService(newRestored);
    assert.ok((await newIdentity.login({ email: account.user.email, password: newPassword })).access_token);
    assert.equal(await newIdentity.userFromAccess(newSession.access_token), account.user.id);
    await assert.rejects(newIdentity.login({ email: account.user.email, password: oldPassword }), status(401));
    assert.equal(createHash('sha256').update(readFileSync(files[1])).digest('hex'), archiveHash);
    assert.deepEqual(await oldRestored.all('PRAGMA foreign_key_check'), []); assert.deepEqual(await newRestored.all('PRAGMA foreign_key_check'), []);
  } finally {
    if (oldRestored) await oldRestored.close(); if (newRestored) await newRestored.close(); await db.close();
    for (const file of files) for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(file + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    rmdirSync(folder);
  }
});
