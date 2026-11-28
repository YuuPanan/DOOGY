import { Body, Controller, Get, Header, Headers, Inject, Injectable, Param, Patch, Put, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody } from './http';

export const displayNameSchema = z.string().trim().min(1).max(100).nullable();
export const consentSchema = z.object({ terms_version: z.string().trim().min(1).max(100), privacy_version: z.string().trim().min(1).max(100), source: z.string().trim().min(1).max(100) }).strict();
const profileBody = z.object({ display_name: displayNameSchema.optional(), consent: consentSchema.optional(), expected_version: z.number().int().min(0) }).strict()
  .refine(input => input.display_name !== undefined || input.consent !== undefined, '请提供显示名或条款接受记录');
const onboardingBody = z.object({ pet_id: z.uuid().nullable().optional(), collar_choice: z.enum(['skipped', 'completed']).nullable().optional(), completed: z.boolean().optional(), expected_version: z.number().int().min(0) }).strict()
  .refine(input => input.pet_id !== undefined || input.collar_choice !== undefined || input.completed !== undefined, '请提供引导选择');
const avatarBody = z.object({ expected_version: z.coerce.number().int().min(0) }).strict();
const avatarQuery = z.object({ version: z.coerce.number().int().positive().optional() });
export const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
type AvatarUpload = { mimetype: string; buffer: Buffer };
const avatarColumns = 'pet_id,id,content_type,size_bytes,sha256,version,created_by,updated_at';

export async function profileFields(db: Db, user: string) {
  const profile = await db.get('SELECT display_name,version,updated_at FROM user_profiles WHERE user_id=?', user);
  const consent = await db.get('SELECT id,terms_version,privacy_version,accepted_at,source,version FROM user_consents WHERE user_id=? ORDER BY version DESC LIMIT 1', user);
  return { display_name: profile?.display_name ?? null, profile_version: profile?.version ?? 0, profile_updated_at: profile?.updated_at ?? null, consent: consent ? { ...consent } : null };
}
export async function saveConsent(db: Db, user: string, consent: z.infer<typeof consentSchema>) {
  const version = (await db.get('SELECT COALESCE(MAX(version),0) AS version FROM user_consents WHERE user_id=?', user))!.version + 1;
  await db.run('INSERT INTO user_consents(id,user_id,terms_version,privacy_version,accepted_at,source,version) VALUES (?,?,?,?,?,?,?)', db.id(), user, consent.terms_version, consent.privacy_version, db.now(), consent.source, version);
}
export async function avatarMetadata(db: Db, pet: string): Promise<Row | null> {
  const row = await db.get(`SELECT ${avatarColumns} FROM pet_avatars WHERE pet_id=?`, pet);
  return row ? { ...row, content_path: `/api/v1/pets/${pet}/avatar/content?version=${row.version}` } : null;
}

@Injectable()
export class ProfileService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async update(user: string, raw: unknown, key?: string) {
    const input = profileBody.parse(raw);
    return this.db.transaction(async () => {
      if (!await this.db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', user)) fail(401, 'UNAUTHENTICATED', '账号不存在或已注销');
      return this.db.idempotent(user, 'PATCH /auth/me', key, input, async () => {
        const current = await profileFields(this.db, user);
        if (current.profile_version !== input.expected_version) fail(409, 'VERSION_CONFLICT', '用户资料已更新，请重新读取');
        await this.db.run('INSERT INTO user_profiles(user_id,display_name,version,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,version=excluded.version,updated_at=excluded.updated_at',
          user, input.display_name === undefined ? current.display_name : input.display_name, current.profile_version + 1, this.db.now());
        if (input.consent) await saveConsent(this.db, user, input.consent);
        await this.db.audit(user, 'account.profile_updated', user, { fields: Object.keys(input).filter(field => field !== 'expected_version') });
        return { ...(await this.db.get('SELECT id,email,created_at FROM users WHERE id=?', user))!, ...await profileFields(this.db, user) };
      });
    });
  }
  async onboarding(user: string): Promise<Row> {
    return this.db.transaction(async () => {
      const saved = await this.db.get('SELECT * FROM user_onboarding WHERE user_id=?', user);
      const pet = saved?.pet_id ? await this.db.get('SELECT p.id FROM pets p JOIN household_members m ON m.household_id=p.household_id WHERE p.id=? AND m.user_id=?', saved.pet_id, user) : null;
      const binding = pet ? await this.db.get('SELECT b.id,b.device_id,b.bound_at,s.last_seen_at,s.reported_at FROM device_bindings b LEFT JOIN device_state s ON s.device_id=b.device_id WHERE b.pet_id=? AND b.unbound_at IS NULL', pet.id) : null;
      const collarChoice = pet ? saved?.collar_choice ?? null : null;
      const completed = Boolean(pet && saved?.completed_at && (collarChoice === 'skipped' || binding));
      return { pet_id: pet?.id ?? null, collar_choice: collarChoice, completed_at: completed ? saved?.completed_at ?? null : null,
        version: saved?.version ?? 0, updated_at: saved?.updated_at ?? null,
        next_step: !pet ? 'create_or_select_pet' : binding || collarChoice === 'skipped' ? completed ? 'done' : 'finish' : 'connect_collar',
        binding: binding ? { device_id: binding.device_id, bound_at: binding.bound_at, source: 'device_bindings' } : null,
        device_report: { status: binding?.last_seen_at ? 'received' : binding ? 'waiting' : 'unbound', received_at: binding?.last_seen_at ?? null, sampled_at: binding?.reported_at ?? null, source: 'device_state' },
        bluetooth: { status: 'unknown', source: 'client_required' } };
    });
  }
  async updateOnboarding(user: string, raw: unknown, key?: string) {
    const input = onboardingBody.parse(raw);
    return this.db.transaction(async () => {
      const result = await this.db.idempotent(user, 'PATCH /auth/onboarding', key, input, async () => {
        const previous = await this.db.get('SELECT * FROM user_onboarding WHERE user_id=?', user);
        if ((previous?.version ?? 0) !== input.expected_version) fail(409, 'VERSION_CONFLICT', '引导选择已更新，请重新读取');
        const petId = input.pet_id === undefined ? previous?.pet_id ?? null : input.pet_id;
        if (petId) await this.db.pet(user, petId);
        const switched = petId !== (previous?.pet_id ?? null);
        const choice = input.collar_choice === undefined ? switched ? null : previous?.collar_choice ?? null : input.collar_choice;
        const binding = petId ? await this.db.get('SELECT id FROM device_bindings WHERE pet_id=? AND unbound_at IS NULL', petId) : null;
        if (choice === 'completed' && !binding) fail(409, 'COLLAR_NOT_BOUND', '连接完成需要有效项圈绑定');
        const finish = input.completed === true;
        if (finish && (!petId || (!binding && choice !== 'skipped'))) fail(409, 'ONBOARDING_INCOMPLETE', '请先选择宠物并连接或跳过项圈');
        const completedAt = finish ? this.db.now() : input.completed === false || switched || !petId || (!binding && choice !== 'skipped') ? null : previous?.completed_at ?? null;
        await this.db.run('INSERT INTO user_onboarding(user_id,pet_id,collar_choice,completed_at,version,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET pet_id=excluded.pet_id,collar_choice=excluded.collar_choice,completed_at=excluded.completed_at,version=excluded.version,updated_at=excluded.updated_at',
          user, petId, choice, completedAt, input.expected_version + 1, this.db.now());
        return this.onboarding(user);
      });
      if (result.pet_id) await this.db.pet(user, result.pet_id);
      return result;
    });
  }
  async avatar(user: string, pet: string, raw: unknown, file: AvatarUpload | undefined, key?: string) {
    const input = avatarBody.parse(raw ?? {});
    if (!file?.buffer.length) fail(400, 'AVATAR_REQUIRED', '请选择非空头像文件');
    const bytes = file.buffer, contentType = file.mimetype.toLowerCase();
    if (bytes.length > MAX_AVATAR_SIZE) fail(413, 'AVATAR_TOO_LARGE', '头像最多为5MiB');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) fail(415, 'UNSUPPORTED_AVATAR_TYPE', '头像支持JPEG、PNG和WebP');
    const starts = (prefix: Buffer) => bytes.subarray(0, prefix.length).equals(prefix);
    const valid = contentType === 'image/jpeg' ? starts(Buffer.from([255, 216, 255])) : contentType === 'image/png' ? starts(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : starts(Buffer.from('RIFF')) && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid) fail(400, 'INVALID_AVATAR_CONTENT', '文件内容与头像类型不符');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.db.transaction(async () => {
      await this.db.pet(user, pet, true);
      return this.db.idempotent(user, `PUT /pets/${pet}/avatar`, key, { ...input, content_type: contentType, size_bytes: bytes.length, sha256 }, async () => {
        const current = await avatarMetadata(this.db, pet);
        if ((current?.version ?? 0) !== input.expected_version) fail(409, 'VERSION_CONFLICT', '宠物头像已更新，请重新读取');
        if (current) await this.db.recordDeletion('pet_avatar', current.id);
        await this.db.run(`INSERT INTO pet_avatars(pet_id,id,content_type,size_bytes,sha256,content_base64,version,created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(pet_id) DO UPDATE SET id=excluded.id,content_type=excluded.content_type,size_bytes=excluded.size_bytes,sha256=excluded.sha256,content_base64=excluded.content_base64,version=excluded.version,created_by=excluded.created_by,updated_at=excluded.updated_at`,
          pet, this.db.id(), contentType, bytes.length, sha256, bytes.toString('base64'), input.expected_version + 1, user, this.db.now());
        await this.db.audit(user, 'pet.avatar_updated', pet, { version: input.expected_version + 1, sha256 });
        return (await avatarMetadata(this.db, pet))!;
      });
    });
  }
  async avatarContent(user: string, pet: string, raw: unknown = {}): Promise<Row> {
    const query = avatarQuery.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet);
      const row = await this.db.get(`SELECT ${avatarColumns},content_base64 FROM pet_avatars WHERE pet_id=?`, pet);
      if (!row) fail(404, 'AVATAR_NOT_FOUND', '尚未设置宠物头像');
      if (query.version !== undefined && query.version !== row.version) fail(404, 'AVATAR_NOT_FOUND', '该头像版本已被替换');
      return { ...row, buffer: Buffer.from(row.content_base64, 'base64') };
    });
  }
}

@ApiTags('用户资料与引导') @ApiBearerAuth() @Controller()
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly service: ProfileService) {}
  @Patch('auth/me') @JsonBody(profileBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  update(@CurrentUser() user: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.service.update(user, body, key); }
  @Get('auth/onboarding')
  onboarding(@CurrentUser() user: string) { return this.service.onboarding(user); }
  @Patch('auth/onboarding') @JsonBody(onboardingBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  saveOnboarding(@CurrentUser() user: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.service.updateOnboarding(user, body, key); }
  @Put('pets/:id/avatar') @ApiConsumes('multipart/form-data') @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiBody({ schema: { type: 'object', required: ['file', 'expected_version'], properties: { file: { type: 'string', format: 'binary' }, expected_version: { type: 'integer', minimum: 0 } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_AVATAR_SIZE, files: 1, fields: 1 } }))
  avatar(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @UploadedFile() file: AvatarUpload | undefined, @Headers('idempotency-key') key?: string) { return this.service.avatar(user, id, body, file, key); }
  @Get('pets/:id/avatar/content') @Header('Cache-Control', 'no-store') @Header('X-Content-Type-Options', 'nosniff')
  async content(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) {
    const file = await this.service.avatarContent(user, id, query);
    return new StreamableFile(file.buffer, { type: file.content_type, length: file.size_bytes, disposition: 'inline' });
  }
}
