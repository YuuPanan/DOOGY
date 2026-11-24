import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { Db, Row } from '../src/db';
import { AccountExportService } from '../src/account-export';
import { PasswordRecoveryService } from '../src/password-recovery';

async function assertRecoveryMetadataExport(db: Db, row: Row, token?: string) {
  const exports = new AccountExportService(db), manifest = await exports.manifest(row.user_id);
  assert.ok(manifest.personal_sections.includes('password_recovery_requests'));
  const page = await exports.page(row.user_id, 'password_recovery_requests', {});
  const item = page.items.find((item: Row) => item.id === row.id);
  assert.ok(item);
  const keys = ['id','user_id','captured_mode','delivery_status','created_at','expires_at','delivered_at','verified_at','consumed_at','invalidated_at','updated_at'];
  assert.deepEqual(Object.keys(item).sort(), keys.sort());
  assert.deepEqual(item, Object.fromEntries(keys.map(key => [key, row[key]])));
  const serialized = JSON.stringify(page);
  for (const secret of [token, row.email_hash, row.token_hash]) if (secret) assert.equal(serialized.includes(secret), false);
}

export async function seedPasswordRecoveryRequest(db: Db, user: string, email: string) {
  const service = new PasswordRecoveryService(db), requested = await service.request({ email });
  assert.equal(requested.accepted, true); assert.equal(Object.hasOwn(requested, 'token'), false);
  const delivered = await service.deliver(requested.request_id);
  assert.equal(typeof delivered.token, 'string');
  const token = delivered.token as string, row = (await db.get('SELECT * FROM password_recovery_requests WHERE id=?', requested.request_id))!;
  assert.equal(row.user_id, user); assert.equal(row.captured_mode, 'offline'); assert.equal(row.delivery_status, 'offline_demo');
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.match(row.email_hash, /^[a-f0-9]{64}$/); assert.ok(row.delivered_at); assert.equal(row.consumed_at, null);
  assert.equal(JSON.stringify(row).includes(token), false);
  assert.equal(Object.hasOwn(await service.deliver(requested.request_id), 'token'), false);
  await assertRecoveryMetadataExport(db, row, token);
  return { request_id: requested.request_id, token_hash: row.token_hash };
}

export async function assertPasswordRecoveryPreserved(source: Db, recovered: Db, expected: Awaited<ReturnType<typeof seedPasswordRecoveryRequest>>) {
  const before = await source.get('SELECT * FROM password_recovery_requests WHERE id=?', expected.request_id);
  const after = await recovered.get('SELECT * FROM password_recovery_requests WHERE id=?', expected.request_id);
  assert.ok(before); assert.ok(after); assert.deepEqual({ ...after }, { ...before }); assert.equal(after.token_hash, expected.token_hash);
  assert.equal(after.delivery_status, 'offline_demo'); assert.equal(after.failed_attempts, 0); assert.equal(after.verified_at, null);
  assert.equal(after.consumed_at, null); assert.equal(after.invalidated_at, null); assert.ok(after.expires_at > after.created_at);
  assert.equal(Object.hasOwn(after, 'token'), false);
  await assertRecoveryMetadataExport(recovered, after);
}
