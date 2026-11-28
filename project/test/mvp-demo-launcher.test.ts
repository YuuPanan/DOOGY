import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer!); }
}

test('MVP演示启动器创建独立合成库、提供可登录的业务页面，Enter停止同次API与Worker', { timeout: 45_000 }, async () => {
  const dataRoot = resolve('data'), existing = new Set(readdirSync(dataRoot));
  const originalFiles = ['.env', '.env.postgres', '.env.recovery', 'data/doogy.db'].filter(existsSync);
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const hashes = new Map(originalFiles.map(path => [path, digest(path)]));
  const inheritedDb = resolve(dataRoot, 'mvp-launcher-inherited-do-not-use.db');
  assert.equal(existsSync(inheritedDb), false);
  const child = spawn(process.execPath, [resolve('dist/scripts/mvp-demo.js')], {
    cwd: resolve('.'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DATA_MODE: 'api', DB_DRIVER: 'postgres', DB_PATH: inheritedDb,
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      PUSH_WEBHOOK_URL: 'https://unexpected-mvp-test.example.invalid/send', PUSH_WEBHOOK_TOKEN: 'synthetic-unconfigured-test' }
  });
  let output = '', directory: string | undefined;
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  child.stdin.on('error', () => { /* The launcher can close stdin during shutdown. */ });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
  });
  const pids = () => [...output.matchAll(/\[DOOGY\] (?:API|WORKER) pid=(\d+)/g)].map(match => Number(match[1]));
  async function wait(pattern: RegExp) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const match = output.match(pattern);
      if (match) return match;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Demo exited before ${pattern}: ${output.slice(-2500)}`);
      await delay(40);
    }
    throw new Error(`Demo timed out before ${pattern}: ${output.slice(-2500)}`);
  }
  async function stopped() {
    for (let attempt = 0; attempt < 100 && pids().some(alive); attempt++) await delay(30);
    assert.deepEqual(pids().filter(alive), [], 'A demo-owned child remains running');
  }
  try {
    const location = await wait(/\[DOOGY MVP\] 数据保存在独立目录：([^\r\n]+)/);
    directory = resolve(location[1].trim());
    assert.equal(dirname(directory), dataRoot);
    assert.match(basename(directory), /^mvp-demo-[a-f0-9]{32}$/);
    assert.equal(existing.has(basename(directory)), false, 'The demo must create a new directory');
    const ready = await wait(/DOOGY API (http:\/\/[^\s]+)\/api\/v1/);
    await wait(/DOOGY worker started/);
    assert.equal(pids().length, 2);
    const origin = ready[1], metadata = JSON.parse(readFileSync(resolve(directory, 'demo.json'), 'utf8'));
    const env = readFileSync(resolve(directory, 'demo.env'), 'utf8');
    assert.equal(metadata.synthetic, true); assert.equal(metadata.location_points, 9);
    assert.match(env, /DATA_MODE=offline/); assert.match(env, /DB_DRIVER=sqlite/);
    assert.ok(env.includes(`DB_PATH=${resolve(directory, 'doogy.db')}`));
    assert.ok(existsSync(resolve(directory, 'doogy.db')));
    assert.equal(existsSync(inheritedDb), false);
    assert.match(output, /Synthetic data only/);
    assert.ok(output.includes(`[DOOGY MVP] 演示入口：${origin}/app/`));
    const healthResponse = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as any;
    assert.equal(health.mode, 'offline'); assert.equal(health.database, 'sqlite'); assert.equal(health.demo, true);
    for (const asset of ['', 'styles.css', 'app.mjs', 'api.mjs', 'history.mjs']) {
      const response = await fetch(`${origin}/app/${asset}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, asset); assert.ok((await response.text()).length > 100);
    }
    const { ApiClient } = await new Function('url', 'return import(url)')(pathToFileURL(resolve('web/api.mjs')).href);
    const owner = new ApiClient(`${origin}/api/v1`, null), viewer = new ApiClient(`${origin}/api/v1`, null);
    await owner.login(metadata.owner); await viewer.login(metadata.viewer);
    assert.equal((await owner.get('/pets')).items.length, 2);
    assert.equal((await viewer.get('/pets')).items.length, 2);
    const overview = await owner.get(`/pets/${metadata.pet_id}/overview`);
    assert.equal(overview.pet.name, '豆豆（合成演示）'); assert.equal(overview.device.is_owner, true);
    assert.equal(overview.device.reporting.execution_source, 'simulator');
    assert.equal((await viewer.get(`/pets/${metadata.pet_id}/overview`)).device.is_owner, false);
    await assert.rejects(viewer.send('PATCH', `/pets/${metadata.pet_id}`, { name: '只读不能修改' }), (error: any) => error.status === 403);
    const locations = await viewer.get(`/pets/${metadata.pet_id}/locations`);
    assert.equal(locations.items.length, 9); assert.ok(locations.items.every((item: any) => item.binding_id));
    const events = await viewer.get(`/pets/${metadata.pet_id}/safety-events`);
    assert.equal(events.items.length, 3); assert.equal(events.items.filter((item: any) => item.status === 'open').length, 1);
    assert.equal((await viewer.get(`/safety-events/${events.items[0].id}`)).delivery_status, 'unknown');
    assert.equal((await owner.get(`/pets/${metadata.pet_id}/care-records`)).items.length, 5);
    child.stdin.write('\n');
    assert.equal((await bounded(closed, 10_000, 'Enter did not stop the MVP demo')).code, 0, output.slice(-1500));
    await stopped();
    for (const [file, hash] of hashes) assert.equal(digest(file), hash, `Demo changed ${file}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.write('\n');
      await bounded(closed, 10_000, 'MVP demo cleanup timed out').catch(() => child.kill());
    }
    for (const pid of pids()) if (alive(pid)) { try { process.kill(pid); } catch { /* Already exited. */ } }
    await stopped();
    if (directory) {
      assert.equal(dirname(directory), dataRoot);
      assert.match(basename(directory), /^mvp-demo-[a-f0-9]{32}$/);
      assert.equal(existing.has(basename(directory)), false);
      for (let attempt = 0; ; attempt++) {
        try { rmSync(directory, { recursive: true, force: true }); break; }
        catch (error) {
          if (!['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 20) throw error;
          await delay(50);
        }
      }
    }
  }
});
