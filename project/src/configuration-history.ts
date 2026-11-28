import { Controller, Get, Header, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Db, Row } from './db';
import { boundedRange, CurrentUser, dateTime, fail, pageQuery } from './http';

const kind = z.enum(['geofence', 'reporting_policy']);
const listQuery = pageQuery.extend({ from: dateTime.optional(), to: dateTime.optional(), kind: kind.optional(), resource_id: z.uuid().optional() });
const scopeSchema = z.object({ user: z.string(), pet: z.string(), from: dateTime, to: dateTime, kind: kind.nullable(), resource_id: z.uuid().nullable() });
const cursorSchema = z.object({ scope: scopeSchema, version: z.number().int().positive() });
type Change = {
  pet_id: string; kind: 'geofence' | 'reporting_policy'; resource_id: string;
  binding_id?: string | null; command_id?: string | null; actor_user_id: string | null;
  action: string; reason: string; before_version: number | null; after_version: number | null;
  before: Row | null; after: Row | null;
};
const present = ({ before_json, after_json, changed_fields_json, ...row }: Row): Row => ({ ...row,
  before: before_json === null ? null : JSON.parse(before_json), after: after_json === null ? null : JSON.parse(after_json),
  changed_fields: JSON.parse(changed_fields_json) });

export async function appendConfigurationHistory(db: Db, change: Change): Promise<Row> {
  return db.transaction(async () => {
    const version = ((await db.get('SELECT MAX(version) AS version FROM pet_configuration_history WHERE pet_id=?', change.pet_id))?.version ?? 0) + 1;
    const changedFields = [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})])]
      .filter(field => !isDeepStrictEqual(change.before?.[field], change.after?.[field])).sort();
    const id = db.id();
    await db.run(`INSERT INTO pet_configuration_history(id,pet_id,version,kind,resource_id,binding_id,command_id,actor_kind,actor_user_id,
      action,reason,before_version,after_version,before_json,after_json,changed_fields_json,changed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, change.pet_id, version, change.kind, change.resource_id, change.binding_id ?? null, change.command_id ?? null,
      change.actor_user_id === null ? 'system' : 'user', change.actor_user_id, change.action, change.reason, change.before_version, change.after_version,
      change.before === null ? null : JSON.stringify(change.before), change.after === null ? null : JSON.stringify(change.after), JSON.stringify(changedFields), db.now());
    return present((await db.get('SELECT * FROM pet_configuration_history WHERE id=?', id))!);
  });
}

export class ConfigurationHistoryService {
  constructor(@Inject(Db) readonly db: Db) {}
  async list(user: string, pet: string, raw: unknown): Promise<Row> {
    const input = listQuery.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, pet);
      let after: z.infer<typeof cursorSchema> | null = null;
      if (input.cursor) {
        try { after = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
        catch { fail(400, 'INVALID_CURSOR', '配置历史游标无效'); }
      }
      const to = input.to ?? after?.scope.to ?? new Date(this.db.clock().getTime() + 1).toISOString();
      const from = input.from ?? after?.scope.from ?? new Date(Date.parse(to) - 31 * 86400000).toISOString(), range = boundedRange(from, to, this.db.clock());
      const scope = { user, pet, ...range, kind: input.kind ?? null, resource_id: input.resource_id ?? null };
      if (after && JSON.stringify(after.scope) !== JSON.stringify(scope)) fail(400, 'INVALID_CURSOR', '配置历史游标不属于本次用户或查询范围');
      const rows = await this.db.all(`SELECT * FROM pet_configuration_history WHERE pet_id=? AND changed_at>=? AND changed_at<?
        AND (? IS NULL OR kind=?) AND (? IS NULL OR resource_id=?) ${after ? 'AND version<?' : ''} ORDER BY version DESC LIMIT ?`,
        pet, range.from, range.to, input.kind ?? null, input.kind ?? null, input.resource_id ?? null, input.resource_id ?? null,
        ...(after ? [after.version] : []), input.limit + 1);
      const last = rows[input.limit - 1];
      return { pet_id: pet, ...range, scope: 'recorded_changes_only', items: rows.slice(0, input.limit).map(present),
        next_cursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ scope, version: last.version })).toString('base64url') : null };
    });
  }
}

@ApiTags('配置修改历史') @ApiBearerAuth() @Controller('pets/:id/configuration-history')
export class ConfigurationHistoryController {
  constructor(@Inject(ConfigurationHistoryService) readonly history: ConfigurationHistoryService) {}
  @Get() @Header('Cache-Control', 'no-store') @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'kind', enum: kind.options, required: false }) @ApiQuery({ name: 'resource_id', required: false })
  @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false, type: Number })
  list(@CurrentUser() user: string, @Param('id') pet: string, @Query() query: unknown) { return this.history.list(user, pet, query); }
}
