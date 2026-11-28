import { Body, Controller, Delete, Get, Header, Headers, Inject, Param, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { Response } from 'express';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, dateTime, fail, pageQuery } from './http';
import { deletePetMedia } from './source-invalidation';
import { MAX_MEDIA_DURATION, MAX_MEDIA_SIZE, mediaValidationAvailable, validateMedia } from './media-validation';

const uploadBody = z.object({ captured_at: dateTime }).strict();
type MediaUpload = { originalname: string; mimetype: string; buffer: Buffer };

const metadataColumns = 'id,pet_id,filename,content_type,size_bytes,sha256,duration_seconds,captured_at,source,created_by,created_at,validation_json';
const cursorSchema = z.object({ user: z.uuid(), pet: z.uuid(), created_at: dateTime, id: z.uuid() });
const present = ({ validation_json, ...row }: Row): Row => ({ ...row, validation: JSON.parse(validation_json), content_path: `/api/v1/media/${row.id}/content` });

export function mediaByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (header === undefined) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const left = match[1] ? Number(match[1]) : null, right = match[2] ? Number(match[2]) : null;
  if ((left !== null && !Number.isSafeInteger(left)) || (right !== null && !Number.isSafeInteger(right))) return null;
  if (left === null) return right! > 0 ? { start: Math.max(0, size - right!), end: size - 1 } : null;
  if (left >= size || (right !== null && right < left)) return null;
  return { start: left, end: right === null ? size - 1 : Math.min(size - 1, right) };
}

export class MediaService {
  constructor(@Inject(Db) readonly db: Db) {}
  async capabilities(user: string, pet: string): Promise<Row> {
    const animal = await this.db.pet(user, pet), member = await this.db.household(user, animal.household_id);
    const writable = member.role !== 'viewer', configured = mediaValidationAvailable();
    return { upload_enabled: writable && configured, max_size_bytes: MAX_MEDIA_SIZE, max_duration_seconds: MAX_MEDIA_DURATION,
      supported_formats: ['m4a', 'mp3', 'wav', 'mp4'], reason: !writable ? 'READ_ONLY' : !configured ? 'MEDIA_VALIDATOR_NOT_CONFIGURED' : null };
  }
  async upload(user: string, pet: string, raw: unknown, file: MediaUpload | undefined, key?: string): Promise<Row> {
    await this.db.pet(user, pet, true);
    const input = uploadBody.parse(raw);
    if (input.captured_at > this.db.now()) fail(400, 'FUTURE_MEDIA_CAPTURE', '用户报告的采集开始时间不能晚于当前时间');
    if (!file?.buffer.length) fail(400, 'MEDIA_REQUIRED', '请选择非空媒体文件');
    if (file.buffer.length > MAX_MEDIA_SIZE) fail(413, 'MEDIA_TOO_LARGE', '媒体文件最多20MiB');
    const filename = z.string().trim().min(1).max(200).parse(file.originalname.replace(/\\/g, '/').split('/').pop());
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const verified = await validateMedia(file.buffer);
    if (Date.parse(input.captured_at) + verified.duration_seconds * 1000 > this.db.clock().getTime()) fail(400, 'FUTURE_MEDIA_END', '采集开始与实际时长所确定的结束时间不能晚于当前时间');
    return this.db.transaction(async () => {
      await this.db.pet(user, pet, true);
      return this.db.idempotent(user, `POST /pets/${pet}/media`, key, { ...input, filename, sha256 }, async () => {
        const id = this.db.id();
        await this.db.run(`INSERT INTO pet_media(id,pet_id,filename,content_type,size_bytes,sha256,content_base64,duration_seconds,captured_at,source,created_by,created_at,validation_json)
          VALUES (?,?,?,?,?,?,?,?,?,'owner_upload',?,?,?)`, id, pet, filename, verified.content_type, file.buffer.length, sha256,
          file.buffer.toString('base64'), verified.duration_seconds, input.captured_at, user, this.db.now(), JSON.stringify(verified.validation));
        await this.db.audit(user, 'pet.media_uploaded', id, { pet_id: pet, content_type: verified.content_type, size_bytes: file.buffer.length });
        return present((await this.db.get(`SELECT ${metadataColumns} FROM pet_media WHERE id=?`, id))!);
      });
    });
  }
  private async authorized(user: string, id: string, write = false): Promise<Row> {
    const row = await this.db.get(`SELECT ${metadataColumns} FROM pet_media WHERE id=?`, id);
    if (!row) fail(404, 'MEDIA_NOT_FOUND', '媒体不存在或已删除');
    await this.db.pet(user, row.pet_id, write);
    return row;
  }
  async metadata(user: string, id: string): Promise<Row> {
    return this.db.transaction(async () => present(await this.authorized(user, id)));
  }
  async list(user: string, pet: string, raw: unknown): Promise<Row> {
    const input = pageQuery.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet);
      let after: z.infer<typeof cursorSchema> | null = null;
      if (input.cursor) {
        try { after = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
        catch { fail(400, 'INVALID_CURSOR', '媒体分页游标无效'); }
        if (after.user !== user || after.pet !== pet) fail(400, 'INVALID_CURSOR', '媒体游标不属于当前用户或宠物');
      }
      const rows = await this.db.all(`SELECT ${metadataColumns} FROM pet_media WHERE pet_id=?
        ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
        pet, ...(after ? [after.created_at, after.created_at, after.id] : []), input.limit + 1);
      const last = rows[input.limit - 1];
      return { items: rows.slice(0, input.limit).map(present), next_cursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ user, pet, created_at: last.created_at, id: last.id })).toString('base64url') : null };
    });
  }
  async content(user: string, id: string, range?: string): Promise<Row> {
    return this.db.transaction(async () => {
      const metadata = await this.authorized(user, id);
      const span = mediaByteRange(range, metadata.size_bytes);
      if (!span) return { status: 416, size_bytes: metadata.size_bytes };
      const row = (await this.db.get('SELECT content_base64 FROM pet_media WHERE id=?', id))!;
      const bytes = Buffer.from(row.content_base64, 'base64');
      return { ...present(metadata), status: range === undefined ? 200 : 206, start: span.start, end: span.end,
        buffer: bytes.subarray(span.start, span.end + 1), content_length: span.end - span.start + 1 };
    });
  }
  async delete(user: string, id: string): Promise<Row> {
    return this.db.transaction(async () => {
      await this.authorized(user, id, true);
      return deletePetMedia(this.db, id);
    });
  }
}

@ApiTags('宠物媒体') @ApiBearerAuth() @Controller()
export class MediaController {
  constructor(@Inject(MediaService) readonly media: MediaService) {}
  @Get('pets/:id/media/capabilities') @Header('Cache-Control', 'no-store')
  capabilities(@CurrentUser() user: string, @Param('id') id: string) { return this.media.capabilities(user, id); }
  @Post('pets/:id/media') @Header('Cache-Control', 'no-store') @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiBody({ schema: { type: 'object', required: ['file', 'captured_at'], properties: { file: { type: 'string', format: 'binary' }, captured_at: { type: 'string', format: 'date-time' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_MEDIA_SIZE, files: 1, fields: 1, fieldSize: 100 } }))
  upload(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @UploadedFile() file: MediaUpload | undefined, @Headers('idempotency-key') key?: string) { return this.media.upload(user, id, body, file, key); }
  @Get('pets/:id/media') @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'limit', required: false, type: Number }) @ApiQuery({ name: 'cursor', required: false })
  list(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.media.list(user, id, query); }
  @Get('media/:id') @Header('Cache-Control', 'no-store')
  metadata(@CurrentUser() user: string, @Param('id') id: string) { return this.media.metadata(user, id); }
  @Get('media/:id/content') @Header('Cache-Control', 'no-store') @Header('X-Content-Type-Options', 'nosniff')
  @ApiHeader({ name: 'Range', required: false, description: '单段字节范围，例如bytes=0-99、bytes=100-或bytes=-100' })
  async content(@CurrentUser() user: string, @Param('id') id: string, @Headers('range') range: string | undefined, @Res({ passthrough: true }) response: Response) {
    const file = await this.media.content(user, id, range);
    response.setHeader('Accept-Ranges', 'bytes');
    if (file.status === 416) {
      response.setHeader('Content-Range', `bytes */${file.size_bytes}`);
      fail(416, 'UNSATISFIABLE_MEDIA_RANGE', '媒体字节范围无效或超出文件大小');
    }
    response.status(file.status);
    if (file.status === 206) response.setHeader('Content-Range', `bytes ${file.start}-${file.end}/${file.size_bytes}`);
    return new StreamableFile(file.buffer, { type: file.content_type, length: file.content_length, disposition: 'inline' });
  }
  @Delete('media/:id') @Header('Cache-Control', 'no-store')
  delete(@CurrentUser() user: string, @Param('id') id: string) { return this.media.delete(user, id); }
}
