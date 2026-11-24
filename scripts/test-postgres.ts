import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set TEST_DATABASE_URL to a dedicated PostgreSQL test server, or create .env.postgres from the example.');
  process.exitCode = 1;
} else {
  const files = ['postgres', 'postgres-backup', 'managed-backup-postgres', 'postgres-concurrency', 'reporting-idempotency-postgres', 'reporting-idempotency-e2e', 'care-withdrawal-e2e', 'care-types-e2e', 'care-attachments-e2e', 'workbench-e2e', 'workbench-mvp-e2e', 'location-share-web', 'notification-inbox-e2e', 'overview-e2e', 'current-observations-e2e', 'activity-feedback-e2e', 'inventory-retention-e2e', 'privacy-e2e', 'privacy-maintenance', 'account-export-e2e', 'device-credentials-e2e', 'operations-e2e', 'safety-close-reason-e2e', 'safety-history-e2e', 'profile-stage-e2e', 'nutrition-stage-e2e', 'wellness-stage-e2e', 'stage-lifecycle', 'content-stage-e2e', 'health-stage-e2e', 'content-health-lifecycle', 'media-stage-e2e', 'media-upload-e2e', 'device-inventory-e2e', 'content-plan-e2e', 'learning-flow-backend', 'behavior-stage', 'behavior-stage-e2e', 'assistant-stage-e2e', 'stage3-lifecycle', 'configuration-history', 'configuration-history-e2e', 'contacts-stage-e2e', 'configuration-contacts-lifecycle', 'interpretation-feedback', 'interpretation-feedback-e2e', 'interpretation-feedback-lifecycle', 'password-recovery-e2e', 'password-recovery-lifecycle', 'contact-alerts', 'contact-alerts-e2e', 'contact-alerts-history', 'contact-alerts-history-e2e', 'contact-alerts-lifecycle', 'contact-alerts-transitions', 'e2e', 'development-e2e', 'pilot-e2e', 'support-workbench-e2e', 'api-mode'].map(name => resolve(__dirname, `../test/${name}.test.js`));
  // Several test files open multiple pools against the same PostgreSQL server.
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], {
    cwd: resolve(__dirname, '../..'), windowsHide: true, stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: url, TEST_E2E_POSTGRES: '1' }
  });
  process.exitCode = result.status ?? 1;
}
