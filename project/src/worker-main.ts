import { Db } from './db';
import { DevicesService } from './devices';
import { NotificationService } from './notifications';
import { TelemetryService } from './telemetry';
import { settings } from './config';
import { ReportingService } from './reporting';
import { SupportService } from './support';
import { RetentionService } from './retention';
import { InventoryRetentionService } from './inventory-retention';
import { BackupScheduler } from './backup-scheduler';
import { BehaviorService } from './behavior';
import { AssistantService } from './assistant';
import { PasswordRecoveryService } from './password-recovery';
import { ContactAlertsService } from './contact-alerts';

async function main() {
  settings();
  const db = await Db.open();
  const notifications = new NotificationService(db);
  const telemetry = new TelemetryService(db, new DevicesService(db), notifications);
  const reporting = new ReportingService(db);
  const support = new SupportService(db);
  const retention = new RetentionService(db);
  const inventoryRetention = new InventoryRetentionService(db);
  const backups = new BackupScheduler();
  const behavior = new BehaviorService(db), assistant = new AssistantService(db);
  const passwordRecovery = new PasswordRecoveryService(db);
  const contactAlerts = new ContactAlertsService(db);
  let retentionCheck = 0;
  let stopped = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopped = true; });
  process.on('message', message => { if (message === 'shutdown') stopped = true; });
  if (process.connected) process.once('disconnect', () => { stopped = true; });
  console.log('DOOGY worker started');
  try {
    while (!stopped) {
      const batchSize = 100;
      await reporting.expire();
      await support.expireDiagnostics();
      await contactAlerts.expire();
      if (Date.now() >= retentionCheck) {
        backups.tick();
        await db.expireIdempotency();
        await passwordRecovery.expire();
        await retention.run();
        await inventoryRetention.run();
        retentionCheck = Date.now() + 60_000;
      }
      const projected = await telemetry.work(batchSize);
      await telemetry.runMaintenance();
      const dispatched = await notifications.dispatch(batchSize);
      const interpreted = await behavior.work(10), answered = await assistant.work(10);
      const alerted = await contactAlerts.work(10);
      // A full batch may leave queued work; reserve the polling delay for idle/partial batches.
      if (projected < batchSize && dispatched < batchSize && interpreted < 10 && answered < 10 && alerted < 10) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { await backups.stop(); await db.close(); if (process.connected) process.disconnect(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
