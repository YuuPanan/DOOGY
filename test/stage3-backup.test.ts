import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { PrivacyService } from '../src/privacy';
import { deletePetMedia } from '../src/source-invalidation';
import { snapshotDatabase } from '../scripts/database-snapshot';
import { seedStage3Data, stage3Tables } from './stage3-fixture';

test('第三批真实SQLite备份恢复：合成媒体原字节/五表保留，删除日志重放不复活旧派生快照', async () => {
  process.env.DATA_MODE = 'offline';
  const prefix = resolve('data', `stage3-backup-${randomUUID()}`), files = ['source', 'snapshot', 'restored'].map(name => `${prefix}-${name}.db`);
  const db = new Db(files[0], () => new Date('2026-11-24T04:00:00.000Z'));
  let recovered: Db | undefined;
  try {
    const password = 'Synthetic-stage3-backup-2026', identity = new IdentityService(db), privacy = new PrivacyService(db);
    const owner = await identity.register({ email: 'stage3-backup@example.invalid', password });
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Third batch backup pet' });
    const seeded = await seedStage3Data(db, owner.user.id, pet.id), before: Record<string, Row[]> = {};
    await db.idempotent(owner.user.id, 'stage3-backup-answer', 'old-answer', {}, () => ({ id: seeded.message, text: 'DERIVED_MEDIA_SECRET' }));
    for (const table of stage3Tables) before[table] = (await db.all(`SELECT * FROM ${table} ORDER BY id`)).map(row => ({ ...row }));
    assert.equal((await snapshotDatabase(files[0], files[1])).integrity, 'ok');
    await deletePetMedia(db, seeded.media);
    const mediaReceipts = await privacy.receipts();
    await privacy.closeAccount(owner.user.id, { password, confirmation: 'DELETE' });
    const receipts = await privacy.receipts();
    await snapshotDatabase(files[1], files[2]); recovered = new Db(files[2], db.clock);
    for (const table of stage3Tables) assert.deepEqual((await recovered.all(`SELECT * FROM ${table} ORDER BY id`)).map(row => ({ ...row })), before[table], table);
    assert.deepEqual(Buffer.from((await recovered.get('SELECT content_base64 FROM pet_media WHERE id=?', seeded.media))!.content_base64, 'base64'), seeded.bytes);
    const replay = new PrivacyService(recovered); await replay.replay(mediaReceipts);
    assert.equal(await recovered.get('SELECT id FROM pet_media WHERE id=?', seeded.media), undefined);
    const message = (await recovered.get('SELECT * FROM assistant_messages WHERE id=?', seeded.message))!;
    assert.equal(message.result_json, null); assert.equal(message.context_json, '{}'); assert.equal(message.evidence_json, '{}');
    assert.equal(message.question, 'Keep my original question');
    assert.equal((await recovered.get('SELECT result_json FROM interpretations WHERE id=?', seeded.interpretation))!.result_json, null);
    assert.equal((await recovered.get('SELECT notes FROM behavior_records WHERE id=?', seeded.behavior))!.notes, 'Manual behavior notes');
    assert.equal(await recovered.get('SELECT key FROM idempotency_keys WHERE key=?', 'old-answer'), undefined);
    await replay.replay(receipts);
    for (const table of stage3Tables) assert.equal((await recovered.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n, 0, table);
    assert.equal((await replay.replay(receipts)).applied, 0);
    assert.deepEqual(await recovered.all('PRAGMA foreign_key_check'), []);
  } finally {
    if (recovered) await recovered.close(); await db.close();
    for (const file of files) for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(file + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
});
