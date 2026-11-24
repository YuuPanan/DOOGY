import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { IntegrationController, verifyWebhook } from '../src/integrations';
import { TelemetryService } from '../src/telemetry';

test('vendor signature authenticates exact bytes and rejects stale, malformed or changed requests', () => {
  const now = Date.parse('2026-11-17T02:00:00Z');
  const timestamp = String(now / 1000);
  const body = Buffer.from('{"event_id":"report-1","payload":{"lat":31.2}}');
  const secret = 'test-only-vendor-secret-at-least-24-characters';
  const sign = (value: Buffer, ts = timestamp) => createHmac('sha256', secret).update(`${ts}.`).update(value).digest('hex');
  const signature = sign(body);
  assert.equal(verifyWebhook(body, timestamp, signature, secret, now), true);
  assert.equal(verifyWebhook(body, timestamp, signature.toUpperCase(), secret, now), true);
  assert.equal(verifyWebhook(Buffer.from(body.toString().replace('31.2', '32.2')), timestamp, signature, secret, now), false);
  assert.equal(verifyWebhook(body, timestamp, signature, 'different-secret', now), false);
  assert.equal(verifyWebhook(body, timestamp, signature, secret, now + 300_001), false);
  assert.equal(verifyWebhook(body, timestamp, signature, secret, now - 300_001), false);
  assert.equal(verifyWebhook(body, timestamp, signature, secret, now + 300_000), true);
  assert.equal(verifyWebhook(body, 'not-a-timestamp', signature, secret, now), false);
  assert.equal(verifyWebhook(body, timestamp, 'broken', secret, now), false);
  assert.equal(verifyWebhook(body, timestamp, '0'.repeat(64), secret, now), false);
  const earlier = String(now / 1000 - 60);
  assert.equal(verifyWebhook(body, earlier, sign(body, earlier), secret, now), true);
});

test('vendor route blocks offline and missing credentials, then delegates only authenticated requests', async () => {
  const oldMode = process.env.DATA_MODE, oldSecret = process.env.VENDOR_WEBHOOK_SECRET;
  const now = Date.parse('2026-11-17T02:00:00Z');
  const db = new Db(':memory:', () => new Date(now));
  let accepted = 0;
  const telemetry = { ingestVendor: (_: unknown) => { accepted++; return { event_id: 'vendor-1', status: 'queued', duplicate: false }; } } as unknown as TelemetryService;
  const controller = new IntegrationController(telemetry, db);
  const raw = Buffer.from('{"event_id":"vendor-1"}');
  const request = { rawBody: raw } as never;
  const timestamp = String(now / 1000);
  const hasStatus = (status: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === status;
  try {
    process.env.DATA_MODE = 'offline';
    delete process.env.VENDOR_WEBHOOK_SECRET;
    assert.throws(() => controller.ingest(request, {}, timestamp, ''), hasStatus(404));
    process.env.DATA_MODE = 'api';
    assert.throws(() => controller.ingest(request, {}, timestamp, ''), hasStatus(503));
    process.env.VENDOR_WEBHOOK_SECRET = 'test-only-vendor-secret-at-least-24-characters';
    assert.throws(() => controller.ingest(request, {}, timestamp, ''), hasStatus(401));
    const signature = createHmac('sha256', process.env.VENDOR_WEBHOOK_SECRET).update(timestamp).update('.').update(raw).digest('hex');
    assert.equal((await controller.ingest(request, { event_id: 'vendor-1' }, timestamp, signature)).event_id, 'vendor-1');
    assert.equal(accepted, 1);
    const status = controller.status();
    assert.equal(status.mode, 'api');
    assert.equal(status.vendor_configured, true);
    assert.ok(!JSON.stringify(status).includes(process.env.VENDOR_WEBHOOK_SECRET));
  } finally {
    if (oldMode === undefined) delete process.env.DATA_MODE; else process.env.DATA_MODE = oldMode;
    if (oldSecret === undefined) delete process.env.VENDOR_WEBHOOK_SECRET; else process.env.VENDOR_WEBHOOK_SECRET = oldSecret;
    await db.close();
  }
});
