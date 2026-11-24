import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { test } from 'node:test';

type Completion = { code: number | null; signal: NodeJS.Signals | null };
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]);
  } finally { clearTimeout(timer!); }
}

function launch(port = 0) {
  const db = resolve('data', `launcher-test-${randomUUID()}.db`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_MODE: 'offline', DB_DRIVER: 'sqlite', DB_PATH: db };
  delete env.VENDOR_WEBHOOK_SECRET;
  delete env.PUSH_WEBHOOK_URL;
  delete env.PUSH_WEBHOOK_TOKEN;
  const child = spawn(process.execPath, [resolve('dist/scripts/start.js')], { cwd: resolve('.'), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  child.stdin.on('error', () => { /* child can close its input during shutdown */ });
  const closed = new Promise<Completion>((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  const pids = () => [...output.matchAll(/\[DOOGY\] (?:API|WORKER) pid=(\d+)/g)].map(match => Number(match[1]));
  async function wait(pattern: RegExp) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const match = output.match(pattern);
      if (match) return match;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Launcher exited before ${pattern}: ${output.slice(-2000)}`);
      await delay(40);
    }
    throw new Error(`Launcher timed out waiting for ${pattern}: ${output.slice(-2000)}`);
  }
  async function cleanup() {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.write('\n');
        await bounded(closed, 9000, 'Launcher did not stop during cleanup').catch(() => child.kill());
      }
      for (const pid of pids()) if (alive(pid)) { try { process.kill(pid); } catch { /* already exited */ } }
      await stopped(pids());
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        // Windows may release file handles just after the process has reported its exit.
        for (let attempt = 0; ; attempt++) {
          try { unlinkSync(db + suffix); break; }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') break;
            if (!['EBUSY', 'EPERM'].includes(code ?? '') || attempt >= 20) throw error;
            await delay(50);
          }
        }
      }
    }
  }
  return { child, closed, wait, pids, cleanup, output: () => output };
}

async function stopped(pids: number[]) {
  for (let i = 0; i < 80 && pids.some(alive); i++) await delay(25);
  assert.deepEqual(pids.filter(alive), [], 'A launcher-owned child remains running');
}

test('启动管理器等待API就绪后启动Worker，Enter同时停止两个自有进程', { timeout: 15_000 }, async () => {
  const run = launch();
  try {
    const ready = await run.wait(/DOOGY API (http:\/\/[^\s]+)\/api\/v1/);
    await run.wait(/\[DOOGY\] WORKER pid=(\d+)/);
    await run.wait(/DOOGY worker started/);
    assert.equal(run.pids().length, 2);
    const response = await fetch(`${ready[1]}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, 'ok');
    assert.ok(run.output().indexOf('DOOGY API http') < run.output().indexOf('[DOOGY] WORKER pid='));
    run.child.stdin.write('\n');
    assert.equal((await bounded(run.closed, 9000, 'Enter did not stop launcher')).code, 0);
    await stopped(run.pids());
  } finally { await run.cleanup(); }
});

test('端口占用时启动失败且不启动Worker，不影响原服务', { timeout: 15_000 }, async () => {
  const original = createServer((_, response) => response.end('original-service'));
  await new Promise<void>(done => original.listen(0, '127.0.0.1', done));
  const address = original.address();
  assert.ok(address && typeof address !== 'string');
  const run = launch(address.port);
  try {
    const result = await bounded(run.closed, 12_000, 'Occupied port did not fail startup');
    assert.ok(typeof result.code === 'number' && result.code !== 0, run.output());
    assert.ok(!run.output().includes('[DOOGY] WORKER pid='));
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(2000) })).text(), 'original-service');
    await stopped(run.pids());
  } finally {
    await run.cleanup();
    await new Promise<void>((done, reject) => original.close(error => error ? reject(error) : done()));
  }
});

test('Worker意外退出时管理器返回失败并停止自己的API', { timeout: 15_000 }, async () => {
  const run = launch();
  try {
    await run.wait(/DOOGY API (http:\/\/[^\s]+)\/api\/v1/);
    const worker = await run.wait(/\[DOOGY\] WORKER pid=(\d+)/);
    await run.wait(/DOOGY worker started/);
    process.kill(Number(worker[1]), 'SIGKILL');
    const result = await bounded(run.closed, 9000, 'Worker failure left launcher running');
    assert.ok(typeof result.code === 'number' && result.code !== 0, run.output());
    await stopped(run.pids());
  } finally { await run.cleanup(); }
});

test('管理器被强制结束后，自有API和Worker通过IPC断开退出', { timeout: 15_000 }, async () => {
  const run = launch();
  try {
    await run.wait(/DOOGY API (http:\/\/[^\s]+)\/api\/v1/);
    await run.wait(/\[DOOGY\] WORKER pid=(\d+)/);
    await run.wait(/DOOGY worker started/);
    process.kill(run.child.pid!, 'SIGKILL');
    await bounded(run.closed, 3000, 'Supervisor did not exit after force termination');
    await stopped(run.pids());
  } finally { await run.cleanup(); }
});
