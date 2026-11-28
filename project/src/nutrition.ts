import { Controller, Get, Inject, Injectable, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { activityWindow, feedingEnergy } from './care';
import { Db, Row } from './db';
import { CurrentUser } from './http';
import { timezoneForPet } from './identity';
import { effectiveGoals } from './wellness';

const dailyQuery = z.object({ date: z.iso.date().optional(), timezone: z.string().optional() });

@Injectable()
export class NutritionService {
  constructor(@Inject(Db) private readonly db: Db) {}
  async daily(user: string, petId: string, raw: unknown): Promise<Row> {
    return this.db.transaction(async () => {
      await this.db.pet(user, petId);
      const query = dailyQuery.parse(raw), timezone = await timezoneForPet(this.db, petId, query.timezone);
      const window = activityWindow(query.date, timezone, this.db.clock());
      const rows = await this.db.all(`SELECT id,value_json,recorded_at,source,created_by,created_at,updated_at FROM care_records
        WHERE pet_id=? AND type='feeding' AND withdrawn_at IS NULL AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at,id`, petId, window.start, window.end);
      const items = rows.map(({ value_json, ...row }) => { const value = JSON.parse(value_json); return { ...row, value, energy: feedingEnergy(value) }; });
      const known = items.filter(item => item.energy.kcal !== null), unknown = items.length - known.length;
      const goals = await effectiveGoals(this.db, petId, window.date);
      return { pet_id: petId, local_date: window.date, timezone, period_start: window.start, period_end: window.end,
        known_kcal: known.length ? Math.round(known.reduce((sum, item) => sum + item.energy.kcal, 0) * 100) / 100 : null,
        target_kcal: goals?.targets.intake_kcal ?? null, goal_id: goals?.id ?? null,
        goal_version: goals?.version ?? null, goal_effective_date: goals?.effective_date ?? null,
        record_count: items.length, known_energy_count: known.length, unknown_energy_count: unknown,
        completeness: !items.length ? 'missing' : unknown ? 'partial' : 'complete',
        completeness_scope: 'recorded_feeding_only', calculation_version: 'label-energy-v1', items, generated_at: this.db.now() };
    });
  }
}

@ApiTags('nutrition') @ApiBearerAuth() @Controller('pets/:id/nutrition')
export class NutritionController {
  constructor(@Inject(NutritionService) private readonly service: NutritionService) {}
  @Get('daily') @ApiQuery({ name: 'date', required: false, example: '2026-11-24' })
  @ApiQuery({ name: 'timezone', required: false, example: 'Asia/Shanghai' })
  daily(@CurrentUser() user: string, @Param('id') petId: string, @Query() query: unknown) { return this.service.daily(user, petId, query); }
}
