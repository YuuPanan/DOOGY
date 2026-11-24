import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { AccountExportService } from '../src/account-export';
import { CareService, CareUpload } from '../src/care';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { PrivacyService } from '../src/privacy';

const password = 'Synthetic-care-attachment-2026';
const status = (code: number, errorCode?: string) => (error: unknown) => error instanceof HttpException && error.getStatus() === code
  && (!errorCode || (error.getResponse() as Row).code === errorCode);
const pdf = Buffer.from('%PDF-1.7\nSynthetic attachment bytes\n%%EOF\n');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1cAAAAASUVORK5CYII=', 'base64');
const upload = (buffer = pdf, originalname = 'report.pdf', mimetype = 'application/pdf'): CareUpload => ({ originalname, mimetype, buffer });
beforeEach(() => { process.env.DATA_MODE = 'offline'; process.env.IDEMPOTENCY_TTL_HOURS = '24'; });

async function fixture() {
  let now = Date.parse('2026-11-17T06:00:00Z');
  const db = new Db(':memory:', () => new Date(now)), identity = new IdentityService(db);
  const owner = await identity.register({ email: 'attachment-owner@example.invalid', password });
  const home = owner.household.id, ownerId = owner.user.id, author = db.id(), viewer = db.id(), outsider = db.id();
  for (const id of [author, viewer, outsider]) await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', id, `${id}@example.invalid`, 'unused', db.now());
  for (const [user, role] of [[author, 'caregiver'], [viewer, 'viewer']]) await db.run('INSERT INTO household_members VALUES (?,?,?,?)', home, user, role, db.now());
  const pet = await identity.createPet(ownerId, { household_id: home, name: 'Attachment pet' });
  const care = new CareService(db);
  const record = await care.create(author, { pet_id: pet.id, type: 'note', recorded_at: db.now(), value: { text: 'Attachment parent' } });
  return { db, identity, home, owner: ownerId, author, viewer, outsider, pet, care, record, advance: () => { now += 1000; } };
}

test('照护附件保存图片与PDF原始字节和文件名，记录、列表、历史与总览只返回元数据', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  assert.deepEqual(f.record.attachments, []);
  const files = [upload(png, 'photo.png', 'image/png'), upload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'photo.jpg', 'image/jpeg'),
    upload(Buffer.from('RIFF\x04\x00\x00\x00WEBPVP8 '), 'photo.webp', 'image/webp'), upload()];
  const metas: Row[] = [];
  for (const file of files) {
    f.advance();
    const meta = await f.care.uploadAttachment(f.author, f.record.id, {}, file);
    assert.equal(meta.filename, file.originalname); assert.equal(meta.content_type, file.mimetype);
    assert.equal(meta.size_bytes, file.buffer.length); assert.equal(meta.sha256, createHash('sha256').update(file.buffer).digest('hex'));
    assert.equal(meta.record_id, f.record.id); assert.equal(meta.created_by, f.author);
    assert.equal(meta.download_path, `/api/v1/care-attachments/${meta.id}/content`);
    const { buffer, ...contentMeta } = await f.care.attachmentContent(f.viewer, meta.id);
    assert.deepEqual(buffer, file.buffer); assert.deepEqual(contentMeta, meta); metas.push(meta);
  }
  const items = (await f.care.attachments(f.viewer, f.record.id)).items;
  assert.deepEqual(items, metas);
  assert.deepEqual((await f.care.get(f.viewer, f.record.id)).attachments, metas);
  assert.deepEqual((await f.care.list(f.viewer, f.pet.id, {})).items[0].attachments, metas);
  assert.deepEqual((await f.care.overview(f.viewer, f.pet.id, { date: '2026-11-17' })).care_records[0].attachments, metas);
  const history = await f.care.history(f.viewer, f.record.id);
  assert.deepEqual(history.current.attachments, metas); assert.equal(history.revisions.length, 4);
  assert.deepEqual(history.revisions[0].record.attachments, []);
  assert.deepEqual(history.revisions[3].record.attachments, metas.slice(0, 3));
  for (const meta of items) { assert.equal('content_base64' in meta, false); assert.equal('buffer' in meta, false); }
});

test('附件校验文件、类型、签名、非空、5MiB边界与每条十份上限，失败不留下附件或修订', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, undefined), status(400, 'ATTACHMENT_REQUIRED'));
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, upload(Buffer.alloc(0))), status(400, 'EMPTY_ATTACHMENT'));
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, upload(pdf, 'report.txt', 'text/plain')), status(415, 'UNSUPPORTED_ATTACHMENT_TYPE'));
  for (const type of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']) {
    await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, upload(Buffer.from('fake file'), 'forged', type)), status(400, 'INVALID_ATTACHMENT_CONTENT'));
  }
  for (const filename of ['', '   ', 'x'.repeat(256)]) await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, { filename }, upload()));
  const maximum = Buffer.alloc(5 * 1024 * 1024); pdf.copy(maximum);
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, upload(Buffer.concat([maximum, Buffer.from([0])]))), status(413, 'ATTACHMENT_TOO_LARGE'));
  assert.equal((await f.care.attachments(f.owner, f.record.id)).items.length, 0);
  assert.equal((await f.care.history(f.owner, f.record.id)).revisions.length, 0);
  assert.equal((await f.care.uploadAttachment(f.author, f.record.id, {}, upload(maximum))).size_bytes, maximum.length);
  for (let index = 1; index < 10; index++) await f.care.uploadAttachment(f.author, f.record.id, {}, upload());
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, upload()), status(409, 'ATTACHMENT_LIMIT_REACHED'));
  assert.equal((await f.care.attachments(f.owner, f.record.id)).items.length, 10);
  assert.equal((await f.care.history(f.owner, f.record.id)).revisions.length, 10);
});

test('附件重试只保存摘要并复用首次元数据，新增一次修订与更新时间，后续编辑快照保留附件元数据', async t => {
  const f = await fixture(); t.after(() => f.db.close()); f.advance();
  const file = upload(pdf, Buffer.from('体检报告.pdf').toString('latin1'));
  const first = await f.care.uploadAttachment(f.author, f.record.id, { filename: '  体检报告.pdf  ' }, file, 'one-upload');
  assert.equal(first.filename, '体检报告.pdf');
  const afterUpload = await f.care.get(f.owner, f.record.id);
  assert.notEqual(afterUpload.updated_at, f.record.updated_at);
  const saved = (await f.db.get('SELECT * FROM idempotency_keys WHERE key=?', 'one-upload'))!;
  const request = JSON.parse(saved.request_json);
  assert.deepEqual(request, { filename: first.filename, content_type: first.content_type, size_bytes: first.size_bytes, sha256: first.sha256 });
  assert.ok(!saved.request_json.includes(pdf.toString('base64'))); assert.ok(!saved.response_json.includes(pdf.toString('base64')));
  f.advance();
  const edited = await f.care.update(f.author, f.record.id, { notes: 'after attachment' });
  assert.deepEqual(await f.care.uploadAttachment(f.author, f.record.id, { filename: '体检报告.pdf' }, file, 'one-upload'), first);
  assert.deepEqual(await f.care.get(f.owner, f.record.id), edited);
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, { filename: 'changed.pdf' }, file, 'one-upload'), status(409, 'IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, { filename: '体检报告.pdf' }, upload(Buffer.from('%PDF-different')), 'one-upload'), status(409, 'IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(await f.db.get('SELECT * FROM idempotency_keys WHERE key=?', 'one-upload'), saved);
  const history = await f.care.history(f.owner, f.record.id);
  assert.equal(history.revisions.length, 2); assert.deepEqual(history.revisions[0].record, f.record);
  assert.deepEqual(history.revisions[1].record.attachments, [first]);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='care.attachment_added'"))!.n, 1);
});

test('附件沿用当前家庭读写权限，撤回保留历史附件且禁止旧幂等键继续上传', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const meta = await f.care.uploadAttachment(f.author, f.record.id, {}, upload(), 'authorized-upload');
  assert.deepEqual((await f.care.attachmentContent(f.viewer, meta.id)).buffer, pdf);
  await assert.rejects(f.care.uploadAttachment(f.viewer, f.record.id, {}, upload()), status(403));
  await assert.rejects(f.care.uploadAttachment(f.outsider, f.record.id, {}, upload()), status(404));
  await assert.rejects(f.care.attachments(f.outsider, f.record.id), status(404));
  await assert.rejects(f.care.attachmentContent(f.outsider, meta.id), status(404));
  await assert.rejects(f.care.attachmentContent(f.owner, f.db.id()), status(404));
  await f.db.run("UPDATE household_members SET role='viewer' WHERE household_id=? AND user_id=?", f.home, f.author);
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, upload(), 'authorized-upload'), status(403));
  await f.db.run('DELETE FROM household_members WHERE household_id=? AND user_id=?', f.home, f.author);
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, upload(), 'authorized-upload'), status(404));
  f.advance();
  const withdrawn = await f.care.withdraw(f.owner, f.record.id, { reason: 'duplicate care fact' });
  assert.deepEqual(withdrawn.attachments, [meta]);
  assert.deepEqual((await f.care.attachments(f.viewer, f.record.id)).items, [meta]);
  assert.deepEqual((await f.care.attachmentContent(f.viewer, meta.id)).buffer, pdf);
  await assert.rejects(f.care.uploadAttachment(f.owner, f.record.id, {}, upload()), status(409, 'CARE_RECORD_WITHDRAWN'));
  await f.db.run('INSERT INTO household_members VALUES (?,?,?,?)', f.home, f.author, 'caregiver', f.db.now());
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, upload(), 'authorized-upload'), status(409, 'CARE_RECORD_WITHDRAWN'));
  assert.equal((await f.care.history(f.viewer, f.record.id)).revisions.length, 2);
});

test('上传审计失败时附件、父记录、修订和幂等键一起回滚，同键随后可以重试', async t => {
  const f = await fixture(); t.after(() => f.db.close()); f.advance();
  const audit = f.db.audit.bind(f.db);
  f.db.audit = async (...args: Parameters<Db['audit']>) => { await audit(...args); if (args[1] === 'care.attachment_added') throw new Error('Synthetic attachment audit failure'); };
  await assert.rejects(f.care.uploadAttachment(f.author, f.record.id, {}, upload(), 'rollback-upload'), /Synthetic attachment audit failure/);
  f.db.audit = audit;
  assert.deepEqual(await f.care.get(f.owner, f.record.id), f.record);
  assert.equal((await f.care.history(f.owner, f.record.id)).revisions.length, 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM care_attachments'))!.n, 0);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE key=?', 'rollback-upload'), undefined);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='care.attachment_added'"))!.n, 0);
  await f.care.uploadAttachment(f.author, f.record.id, {}, upload(), 'rollback-upload');
  assert.equal((await f.care.history(f.owner, f.record.id)).revisions.length, 1);
});

test('账号导出附件分页每页一份并带可还原内容，撤权和父级删除清理附件与缓存且保留其他宠物', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = await f.care.uploadAttachment(f.author, f.record.id, {}, upload(pdf, 'first.pdf'), 'delete-parent-upload');
  const second = await f.care.uploadAttachment(f.author, f.record.id, {}, upload(png, 'second.png', 'image/png'));
  const otherPet = await f.identity.createPet(f.owner, { household_id: f.home, name: 'Keep other attachments' });
  const otherRecord = await f.care.create(f.owner, { pet_id: otherPet.id, type: 'note', recorded_at: f.db.now(), value: {} });
  const other = await f.care.uploadAttachment(f.owner, otherRecord.id, {}, upload());
  const exporter = new AccountExportService(f.db), manifest = await exporter.manifest(f.viewer);
  assert.ok(manifest.households.find((row: Row) => row.id === f.home).sections.includes('care_attachments'));
  const query = { household_id: f.home, limit: 200 };
  const page = await exporter.page(f.viewer, 'care_attachments', query);
  assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
  const rows = [...page.items]; let cursor = page.next_cursor;
  while (cursor) {
    const next = await exporter.page(f.viewer, 'care_attachments', { ...query, cursor });
    assert.equal(next.items.length, 1); rows.push(...next.items); cursor = next.next_cursor;
    assert.ok(rows.length <= 3);
  }
  assert.deepEqual(rows.map(row => row.id).sort(), [first.id, second.id, other.id].sort());
  for (const row of rows) {
    const content = await f.care.attachmentContent(f.viewer, row.id);
    assert.deepEqual(Buffer.from(row.content_base64, 'base64'), content.buffer);
    assert.equal(row.filename, content.filename); assert.equal(row.sha256, content.sha256);
  }
  await f.db.run('DELETE FROM household_members WHERE household_id=? AND user_id=?', f.home, f.viewer);
  await assert.rejects(exporter.page(f.viewer, 'care_attachments', { ...query, cursor: page.next_cursor }), status(404));
  await new PrivacyService(f.db).deletePet(f.owner, f.pet.id, { password, confirmation: f.pet.id });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM care_attachments WHERE record_id=?', f.record.id))!.n, 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM care_record_revisions WHERE record_id=?', f.record.id))!.n, 0);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE key=?', 'delete-parent-upload'), undefined);
  await assert.rejects(f.care.attachmentContent(f.owner, first.id), status(404));
  assert.deepEqual((await f.care.attachmentContent(f.owner, other.id)).buffer, pdf);
  const remaining = await exporter.page(f.owner, 'care_attachments', query);
  assert.deepEqual(remaining.items.map((row: Row) => row.id), [other.id]);
});
