import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { ProfileService } from '../src/profile';
import { PrivacyService } from '../src/privacy';
import { WellnessService } from '../src/wellness';
import { snapshotDatabase } from '../scripts/database-snapshot';

test('第一批真实SQLite备份恢复：六表逐字段及头像字节保留，替换/宠物删除/注销日志按顺序重放', async () => {
  process.env.DATA_MODE = 'offline';
  const prefix = resolve('data', `stage-backup-${randomUUID()}`), files = ['source', 'snapshot', 'restored'].map(name => `${prefix}-${name}.db`);
  const db = new Db(files[0], () => new Date('2026-11-24T04:00:00.000Z'));
  let recovered: Db | undefined;
  try {
    const identity = new IdentityService(db), profile = new ProfileService(db), wellness = new WellnessService(db), privacy = new PrivacyService(db);
    const password = 'Synthetic-stage-backup-2026';
    const account = await identity.register({ email: 'stage-backup@example.invalid', password, display_name: 'Backup owner',
      consent: { terms_version: 'user-provided-t1', privacy_version: 'user-provided-p1', source: 'stage-backup' } });
    const user = account.user.id, pet = await identity.createPet(user, { household_id: account.household.id, name: 'Backup pet' });
    await profile.updateOnboarding(user, { expected_version: 0, pet_id: pet.id, collar_choice: 'skipped', completed: true }, 'backup-onboarding');
    for (const version of [0, 1]) {
      await wellness.putGoals(user, pet.id, { effective_date: '2026-11-24', expected_version: version,
        targets: { active_minutes: 30 + version * 10, intake_kcal: 500 }, source: 'backup-user' }, `backup-goals-${version}`);
      await wellness.putCheckIn(user, pet.id, { date: '2026-11-24', timezone: 'Asia/Shanghai' }, {
        expected_version: version, values: { appetite: 'owner-described', energy: null }, notes: `Backup version ${version + 1}`,
      }, `backup-check-${version}`);
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1cAAAAASUVORK5CYII=', 'base64');
    const avatar = await profile.avatar(user, pet.id, { expected_version: 0 }, { mimetype: 'image/png', buffer: png }, 'backup-avatar');
    const stageTables = ['user_profiles','user_consents','user_onboarding','pet_avatars','pet_goals','body_check_ins'];
    const before: Record<string, Row[]> = {};
    for (const table of stageTables) before[table] = (await db.all(`SELECT * FROM ${table} ORDER BY ${table === 'user_profiles' || table === 'user_onboarding' ? 'user_id' : 'id'}`)).map(row => ({ ...row }));
    assert.equal((await snapshotDatabase(files[0], files[1])).integrity, 'ok');
    await profile.avatar(user, pet.id, { expected_version: 1 }, { mimetype: 'image/png', buffer: Buffer.concat([png, Buffer.from('replacement')]) }, 'replacement-avatar');
    await privacy.deletePet(user, pet.id, { password, confirmation: pet.id });
    await privacy.closeAccount(user, { password, confirmation: 'DELETE' });
    const receipts = await privacy.receipts();
    assert.ok(receipts.some(row => row.kind === 'pet_avatar' && row.resource_id === avatar.id));
    await snapshotDatabase(files[1], files[2]);
    recovered = new Db(files[2], db.clock);
    for (const table of stageTables) assert.deepEqual((await recovered.all(`SELECT * FROM ${table} ORDER BY ${table === 'user_profiles' || table === 'user_onboarding' ? 'user_id' : 'id'}`)).map(row => ({ ...row })), before[table], table);
    assert.deepEqual((await new ProfileService(recovered).avatarContent(user, pet.id)).buffer, png);
    const replay = new PrivacyService(recovered);
    await replay.replay(receipts.filter(row => row.kind === 'pet_avatar'));
    assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM pet_avatars'))!.n, 0);
    assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM pet_goals'))!.n, 2);
    assert.equal((await recovered.get('SELECT COUNT(*) AS n FROM body_check_ins'))!.n, 2);
    assert.equal(await recovered.get('SELECT key FROM idempotency_keys WHERE key=?', 'backup-avatar'), undefined);
    await replay.replay(receipts);
    for (const table of stageTables) assert.equal((await recovered.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n, 0, table);
    assert.equal((await recovered.get('SELECT closed_at FROM users WHERE id=?', user))!.closed_at !== null, true);
    assert.equal((await replay.replay(receipts)).applied, 0);
    assert.deepEqual(await recovered.all('PRAGMA foreign_key_check'), []);
  } finally {
    if (recovered) await recovered.close();
    await db.close();
    for (const file of files) for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(file + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
});
