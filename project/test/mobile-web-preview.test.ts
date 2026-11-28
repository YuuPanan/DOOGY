import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/app';
import { Db } from '../src/db';

const keys = ['DOOGY_MOBILE_WEB_PREVIEW_DIRECTORY','DATA_MODE','DB_DRIVER','DOOGY_DEMO','HOST'] as const;
function environment() {
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const artifacts = resolve(__dirname, '../../../artifacts'); mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(resolve(artifacts, 'mobile-web-preview-test-'));
  writeFileSync(resolve(directory, 'index.html'), '<!doctype html><title>Synthetic mobile preview fixture</title>');
  Object.assign(process.env, { DOOGY_MOBILE_WEB_PREVIEW_DIRECTORY: directory, DATA_MODE: 'offline', DB_DRIVER: 'sqlite', DOOGY_DEMO: '1', HOST: '127.0.0.1' });
  return () => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } };
}

test('mobile web preview serves the generated page alongside the real guarded API in an explicit loopback demo', async () => {
  const restore = environment(), db = new Db(':memory:'); let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({ db, quiet: true }); await app.listen(0, '127.0.0.1'); const root = await app.getUrl();
    const page = await fetch(root), text = await page.text(); assert.equal(page.status, 200); assert.match(text, /Synthetic mobile preview fixture/);
    for (const [path, status] of [['/api/v1/health', 200], ['/api/v1/pets', 401]] as const) {
      const response = await fetch(root + path); await response.arrayBuffer(); assert.equal(response.status, status);
    }
  } finally { if (app) await app.close(); await db.close(); restore(); }
});

for (const [name, change] of [
  ['ordinary environment', () => { process.env.DOOGY_DEMO = '0'; }],
  ['non-loopback listener', () => { process.env.HOST = '0.0.0.0'; }],
  ['external business mode', () => { process.env.DATA_MODE = 'api'; }],
  ['directory outside generated artifacts', () => { process.env.DOOGY_MOBILE_WEB_PREVIEW_DIRECTORY = resolve(__dirname, '../..'); }],
] as const) test(`mobile web preview rejects ${name} before opening an application`, async () => {
  const restore = environment(), db = new Db(':memory:'); let app: Awaited<ReturnType<typeof createApp>> | undefined; change();
  try { await assert.rejects(createApp({ db, quiet: true }).then(value => { app = value; return value; }), /mobile web preview/i); }
  finally { if (app) await app.close(); await db.close(); restore(); }
});
