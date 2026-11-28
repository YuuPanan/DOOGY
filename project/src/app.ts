import 'reflect-metadata';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Request, Response, NextFunction } from 'express';
import { Db } from './db';
import { ApiErrors, Public } from './http';
import { AuthGuard, HouseholdController, IdentityController, IdentityService, PetController } from './identity';
import { DevicesController, DevicesService } from './devices';
import { FencesController, FencesService } from './fences';
import { NotificationController, NotificationService } from './notifications';
import { TelemetryController, TelemetryService } from './telemetry';
import { CareAttachmentsController, CareController, CareService } from './care';
import { IntegrationController } from './integrations';
import { settings } from './config';
import { SafetyController, SafetyService } from './safety';
import { ReportingController, ReportingService } from './reporting';
import { SharesController, SharesService } from './shares';
import { SupportAdminController, SupportController, SupportService } from './support';
import { ObservationsController, ObservationsService } from './observations';
import { OperationsController, OperationsService } from './operations';
import { DeviceCredentialsController, DeviceCredentialsService } from './device-credentials';
import { AccountExportController, AccountExportService } from './account-export';
import { PrivacyController, PrivacyService } from './privacy';
import { RetentionController, RetentionService } from './retention';
import { InventoryRetentionController, InventoryRetentionService } from './inventory-retention';
import { demoAccounts } from './demo-accounts';
import { WellnessController, WellnessService } from './wellness';
import { NutritionController, NutritionService } from './nutrition';
import { ProfileController, ProfileService } from './profile';
import { ContentController, ContentService } from './content';
import { HealthObservationsController, HealthObservationsService } from './health-observations';
import { MediaController, MediaService } from './media';
import { BehaviorController, BehaviorService } from './behavior';
import { AssistantController, AssistantService } from './assistant';
import { ConfigurationHistoryController, ConfigurationHistoryService } from './configuration-history';
import { ContactsController, ContactsService } from './contacts';
import { PasswordRecoveryController, PasswordRecoveryService } from './password-recovery';
import { ContactAlertsController, ContactAlertsService } from './contact-alerts';

@Controller()
class HealthController {
  constructor(@Inject(Db) readonly db: Db) {}
  @Public() @Get('health') async health() { await this.db.get('SELECT 1'); const demo = process.env.DOOGY_DEMO === '1'; return { status: 'ok', mode: settings().DATA_MODE, database: this.db.driver, demo, ...(demo ? { demo_accounts: demoAccounts } : {}), time: this.db.now() }; }
}

export async function createApp(options: { db?: Db; quiet?: boolean } = {}) {
  const runtime = settings();
  let mobilePreview: string | undefined;
  if (process.env.DOOGY_MOBILE_WEB_PREVIEW_DIRECTORY) {
    if (runtime.DATA_MODE !== 'offline' || runtime.DB_DRIVER !== 'sqlite' || process.env.DOOGY_DEMO !== '1' || process.env.HOST !== '127.0.0.1')
      throw new Error('Mobile web preview requires an explicit offline SQLite demo on 127.0.0.1');
    const requested = resolve(process.env.DOOGY_MOBILE_WEB_PREVIEW_DIRECTORY), artifacts = realpathSync(resolve(__dirname, '../../../artifacts'));
    if (!existsSync(requested)) throw new Error('Mobile web preview export is missing');
    mobilePreview = realpathSync(requested);
    const within = relative(artifacts, mobilePreview), index = resolve(mobilePreview, 'index.html');
    if (!within || within.startsWith('..') || isAbsolute(within) || !existsSync(index) || !statSync(index).isFile())
      throw new Error('Mobile web preview must use a generated artifacts directory containing index.html');
  }
  const db = options.db ?? await Db.open();
  @Module({
    controllers: [ContactAlertsController, PasswordRecoveryController, ConfigurationHistoryController, ContactsController, MediaController, BehaviorController, AssistantController, ContentController, HealthObservationsController, ProfileController, WellnessController, NutritionController, HealthController, IdentityController, HouseholdController, PetController, DevicesController, FencesController,
      TelemetryController, NotificationController, CareController, CareAttachmentsController, IntegrationController, SafetyController, ReportingController,
      SharesController, SupportController, SupportAdminController, ObservationsController, OperationsController, DeviceCredentialsController, AccountExportController, PrivacyController, RetentionController, InventoryRetentionController],
    providers: [{ provide: Db, useValue: db }, ContactAlertsService, PasswordRecoveryService, ConfigurationHistoryService, ContactsService, MediaService, BehaviorService, AssistantService, ContentService, HealthObservationsService, ProfileService, WellnessService, NutritionService, IdentityService, DevicesService, FencesService, NotificationService, TelemetryService, CareService, SafetyService, ReportingService,
      SharesService, SupportService, ObservationsService, OperationsService, DeviceCredentialsService, AccountExportService, PrivacyService, RetentionService, InventoryRetentionService,
      { provide: APP_GUARD, useClass: AuthGuard }]
  })
  class AppModule {}
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: options.quiet ? false : ['log', 'error', 'warn'] });
  app.setGlobalPrefix('api/v1');
  app.use((_: Request, response: Response, next: NextFunction) => { response.setHeader('x-request-id', randomUUID()); next(); });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path === '/app') response.redirect('/app/');
    else next();
  });
  app.useStaticAssets(resolve(__dirname, '../../web'), { prefix: '/app/' });
  if (mobilePreview) app.useStaticAssets(mobilePreview, { prefix: '/' });
  app.useGlobalFilters(new ApiErrors());
  const config = new DocumentBuilder().setTitle('DOOGY Backend').setDescription('本地离线 / API 接入共用业务 API；设备与供应商适配说明见 docs/integrations.md')
    .setVersion('0.1.0').addBearerAuth().build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'openapi.json' });
  await app.init();
  return app;
}
