import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { main, seedAppDemo } from '../scripts/app-demo';
import { createApp } from '../src/app';
import { AssistantService } from '../src/assistant';
import { BehaviorService } from '../src/behavior';
import { ContactAlertsService } from '../src/contact-alerts';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { openBackendFixture } from './backend-fixture';

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hash = (filename: string) => createHash('sha256').update(readFileSync(filename)).digest('hex');
function cleanMode() {
  const saved = { DATA_MODE: process.env.DATA_MODE, DOOGY_DEMO: process.env.DOOGY_DEMO };
  process.env.DATA_MODE = 'offline'; process.env.DOOGY_DEMO = '1';
  return () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

test('App synthetic demo closes real HTTP learning, goals, care, interpretation, assistant and contacts without external business calls', async () => {
  const restore = cleanMode(), backend = await openBackendFixture(() => new Date('2026-11-24T06:00:00Z')), db = backend.db;
  const previousFetch = globalThis.fetch; let app: Awaited<ReturnType<typeof createApp>> | undefined, origin = '', external = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!origin || new URL(target).origin !== origin) { external++; throw new Error('Unexpected external business request'); }
      return previousFetch(input, init);
    };
    const demo = await seedAppDemo(db);
    assert.equal(demo.synthetic, true); assert.equal(demo.demo_kind, 'app_closed_loop');
    assert.equal(/token|password_hash|content_base64|claim_code/.test(JSON.stringify(demo)), false);
    app = await createApp({ db, quiet: true }); await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
    let token = '';
    async function api(path: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, access = token) {
      const response = await fetch(`${origin}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await response.json() as any; assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    token = (await api('/auth/login', 'POST', demo.owner, 200)).access_token;
    assert.equal((await api('/auth/onboarding')).next_step, 'done');
    const content = await api('/content'); assert.equal(content.items.length, 10);
    assert.equal(content.items.filter((row: any) => row.kind === 'lesson').length, 5);
    for (const item of content.items) {
      assert.match(item.title, /合成演示/); assert.match(item.body, /合成演示/); assert.match(item.applicability, /合成/);
      assert.equal(item.review.reviewer, '仅软件流程审阅'); assert.ok(item.sources.every((source: any) => source.title.includes('合成')));
    }
    const lessons = await api('/lessons'), lesson = await api(`/lessons/${lessons.items[0].id}`);
    const completed = lesson.lesson.steps.map((row: any) => row.id);
    await api(`/lessons/${lesson.id}/progress`, 'PUT', { content_version: lesson.content_version, expected_version: 0, completed_step_ids: completed, learned: true });
    const reread = await api(`/lessons/${lesson.id}`); assert.equal(reread.progress.version, 1); assert.equal(reread.progress.learned, true);
    assert.deepEqual(reread.progress.completed_step_ids.sort(), completed.sort());
    const plan = (await api('/content?kind=plan&category=exercise')).items[0]; assert.ok(plan.exercise_plan);
    const path = `/pets/${demo.pet_id}`, period = `?date=${demo.local_date}&timezone=${encodeURIComponent(demo.timezone)}`;
    const goals = await api(path + '/goals' + period);
    assert.deepEqual(goals.goals.targets, { active_minutes: null, steps: null, intake_kcal: null });
    const adopted = { name: plan.title, content_version: `${plan.id}@${plan.content_version}`, ...plan.exercise_plan };
    await api(path + '/goals', 'PUT', { effective_date: demo.local_date, expected_version: goals.effective_date_version,
      targets: goals.goals.targets, plan: adopted, source: 'user_provided' });
    const savedGoals = await api(path + '/goals' + period); assert.equal(savedGoals.effective_date_version, 2); assert.deepEqual(savedGoals.goals.plan, adopted);
    const body = await api(path + '/body-check-ins' + period);
    await api(path + '/body-check-ins' + period, 'PUT', { expected_version: body.version, values: { ...body.values, appetite: '合成HTTP复读原文' }, notes: body.notes, toileting_record_id: body.toileting_record_id });
    assert.equal((await api(path + '/body-check-ins' + period)).values.appetite, '合成HTTP复读原文');
    const nutrition = await api(path + '/nutrition/daily' + period); assert.equal(nutrition.known_kcal, 40); assert.ok(nutrition.unknown_energy_count > 0);
    assert.ok((await api(path + '/health-observations')).items.some((row: any) => row.id === demo.examples.assessment_id));
    const media = await api(`/media/${demo.examples.media_id}`); assert.equal(media.source, 'synthetic'); assert.equal(media.validation.method, 'synthetic_fixture');
    const mediaResponse = await fetch(`${origin}/api/v1/media/${media.id}/content`, { headers: { authorization: `Bearer ${token}`, range: 'bytes=0-43' } });
    assert.equal(mediaResponse.status, 206); assert.equal(Buffer.from(await mediaResponse.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
    assert.equal((await api(`/interpretations/${demo.examples.interpretation_id}`)).status, 'pending');
    await app.get(BehaviorService).work(10); const interpreted = await api(`/interpretations/${demo.examples.interpretation_id}`);
    assert.equal(interpreted.status, 'succeeded'); assert.equal(interpreted.execution_source, 'offline_demo'); assert.equal(interpreted.model_version, null);
    assert.equal(interpreted.evidence.used_by_model, false); assert.deepEqual(interpreted.result.claims, []);
    const feedback = await api(`/interpretations/${interpreted.id}/feedback`, 'POST', { expected_attempt: interpreted.attempt, assessment: 'helpful', comment: '合成反馈保存复读' });
    assert.ok((await api(`/interpretations/${interpreted.id}/feedback?expected_attempt=${interpreted.attempt}`)).items.some((row: any) => row.id === feedback.id));
    const conversation = await api(path + '/assistant-conversations', 'POST', { title: '合成HTTP新会话' });
    const message = await api(`/assistant-conversations/${conversation.id}/messages`, 'POST', { question: '合成问题：验证课程引用保存复读', context: { kind: 'lesson', lesson_id: lesson.id, lesson_version: lesson.content_version } }, 202);
    await app.get(AssistantService).work(10); const answered = await api(`/assistant-messages/${message.id}`);
    assert.equal(answered.status, 'succeeded'); assert.equal(answered.execution_source, 'offline_demo'); assert.equal(answered.model_version, null);
    assert.match(answered.result.text, /没有调用模型/); assert.ok((await api(`/assistant-conversations/${conversation.id}/messages`)).items.some((row: any) => row.id === message.id));
    const contacts = await api(`/households/${demo.household_id}/contacts`); assert.equal(contacts.items.length, 2);
    const granted = contacts.items.find((row: any) => row.consent.status === 'reported_granted'); assert.equal(granted.consent.verified, false);
    const alert = await api(path + '/contact-alerts', 'POST', { message: '合成HTTP通知，禁止真实发送', consent: true,
      recipients: [{ contact_id: granted.id, expected_version: granted.version, method: 'email' }] }, 202);
    await app.get(ContactAlertsService).work(10);
    assert.equal((await api(`/contact-alerts/${alert.id}`)).status, 'simulated');
    assert.equal((await api(`/contact-alerts/${demo.examples.contact_alert_id}`)).status, 'partial');
    assert.ok((await api(path + '/contact-alerts')).items.some((row: any) => row.id === alert.id));
    const viewer = (await api('/auth/login', 'POST', demo.viewer, 200)).access_token;
    assert.equal((await api('/auth/onboarding', 'GET', undefined, 200, viewer)).next_step, 'done');
    assert.equal((await api(`/lessons/${lesson.id}`, 'GET', undefined, 200, viewer)).progress.learned, false);
    await api(path + '/goals', 'PUT', { effective_date: demo.local_date, expected_version: 2, targets: savedGoals.goals.targets }, 403, viewer);
    await api(`/contact-alerts/${alert.id}`, 'GET', undefined, 200, viewer);
    const fresh = await api('/auth/register', 'POST', { email: `fresh-${db.id()}@example.invalid`, password: '12345678', household_name: '合成无宠物新账号' });
    assert.equal((await api('/pets', 'GET', undefined, 200, fresh.access_token)).items.length, 0);
    assert.equal((await api('/auth/onboarding', 'GET', undefined, 200, fresh.access_token)).next_step, 'create_or_select_pet');
    assert.equal(external, 0);
  } finally { globalThis.fetch = previousFetch; if (app) await app.close(); await backend.close(); restore(); }
});

test('App demo refuses an existing business database or api mode before changing rows; ordinary app startup does not import the catalog', async () => {
  const restore = cleanMode(), db = new Db(':memory:'); let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await new IdentityService(db).register({ email: 'ordinary@example.invalid', password: '12345678', household_name: '原有业务家庭' });
    const before = await db.all('SELECT id,email,password_hash FROM users');
    await assert.rejects(seedAppDemo(db), /空数据库/); assert.deepEqual(await db.all('SELECT id,email,password_hash FROM users'), before);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM content_items'))!.n, 0);
    delete process.env.DOOGY_DEMO;
    app = await createApp({ db, quiet: true }); await app.listen(0, '127.0.0.1');
    const session = await new IdentityService(db).login({ email: 'ordinary@example.invalid', password: '12345678' });
    const response = await fetch(`${await app.getUrl()}/api/v1/content`, { headers: { authorization: `Bearer ${session.access_token}` } });
    assert.equal(response.status, 200); assert.deepEqual((await response.json() as any).items, []);
    const health = await fetch(`${await app.getUrl()}/api/v1/health`).then(response => response.json()) as any;
    assert.equal(health.demo, false); assert.equal(Object.hasOwn(health, 'demo_accounts'), false);
    process.env.DATA_MODE = 'api'; await assert.rejects(seedAppDemo(db), /offline/); assert.deepEqual(await db.all('SELECT id,email,password_hash FROM users'), before);
  } finally { if (app) await app.close(); await db.close(); restore(); }
});

test('App demo rejects invalid CLI arguments before changing inherited connection settings', async () => {
  const before = { HOST: process.env.HOST, PORT: process.env.PORT, DB_PATH: process.env.DB_PATH, DATA_MODE: process.env.DATA_MODE };
  for (const args of [['0'], ['65536'], ['--unknown'], ['1234', 'extra'], ['--loopback', '--loopback']]) await assert.rejects(main(args));
  assert.deepEqual({ HOST: process.env.HOST, PORT: process.env.PORT, DB_PATH: process.env.DB_PATH, DATA_MODE: process.env.DATA_MODE }, before);
});

test('App demo launcher uses a new isolated loopback database and the existing API/Worker supervisor, preserving inherited user files', { timeout: 45000 }, async () => {
  const original = ['.env', '.env.postgres', 'data/doogy.db'].filter(existsSync), hashes = new Map(original.map(file => [file, hash(file)]));
  const inherited = resolve('data', `app-demo-do-not-open-${randomUUID()}.db`);
  const child = spawn(process.execPath, [resolve(__dirname, '../scripts/app-demo.js'), '--loopback'], { cwd: resolve('.'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DATA_MODE: 'api', DB_DRIVER: 'postgres', DB_PATH: inherited, DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      PUSH_WEBHOOK_URL: 'https://unused.example.invalid/send', PUSH_WEBHOOK_TOKEN: 'synthetic-never-send' } });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.stdin.on('error', () => {});
  const pids = () => [...output.matchAll(/\[DOOGY\] (?:API|WORKER) pid=(\d+)/g)].map(match => Number(match[1]));
  const closed = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
  async function wait(pattern: RegExp) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const match = output.match(pattern); if (match) return match;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(output.slice(-4000)); await delay(40);
    }
    throw new Error(`Timed out: ${output.slice(-4000)}`);
  }
  try {
    const location = await wait(/\[DOOGY APP DEMO\] 数据保存在独立目录：([^\r\n]+)/), directory = resolve(location[1].trim());
    assert.equal(dirname(directory), resolve('data')); assert.match(basename(directory), /^app-demo-[a-f0-9]{32}$/);
    const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.environment.HOST, '127.0.0.1'); assert.equal(manifest.environment.DATA_MODE, 'offline'); assert.equal(manifest.environment.DB_DRIVER, 'sqlite');
    assert.equal(manifest.content.length, 10); assert.equal(existsSync(inherited), false); assert.equal(/device_token|claim_code|access_token|refresh_token/.test(JSON.stringify(manifest)), false);
    const ready = await wait(/DOOGY API (http:\/\/127\.0\.0\.1:\d+)\/api\/v1/); await wait(/DOOGY worker started/); assert.equal(pids().length, 2);
    const login = await fetch(`${ready[1]}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest.owner) });
    assert.equal(login.status, 200); const session = await login.json() as any;
    const get = async (path: string) => { const response = await fetch(`${ready[1]}/api/v1${path}`, { headers: { authorization: `Bearer ${session.access_token}` } }); assert.equal(response.status, 200); return response.json() as Promise<any>; };
    assert.equal((await get('/lessons')).items.length, 5);
    const deadline = Date.now() + 6000; let task: any;
    do { task = await get(`/interpretations/${manifest.examples.interpretation_id}`); if (task.status !== 'pending') break; await delay(50); } while (Date.now() < deadline);
    assert.equal(task.status, 'succeeded'); assert.equal(task.execution_source, 'offline_demo');
    assert.equal((await get(`/assistant-messages/${manifest.examples.message_id}`)).status, 'succeeded');
    assert.equal((await get(`/contact-alerts/${manifest.examples.contact_alert_id}`)).status, 'partial');
    child.stdin.write('\n'); const code = await Promise.race([closed, delay(10000).then(() => { throw new Error('App demo did not stop'); })]);
    assert.equal(code, 0, output.slice(-2000));
    for (let n = 0; n < 100 && pids().some(alive); n++) await delay(30); assert.deepEqual(pids().filter(alive), []);
    for (const [file, digest] of hashes) assert.equal(hash(file), digest, `Changed ${file}`);
    // Keep this invocation's synthetic directory and manifest for review; never recycle old demos.
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.stdin.write('\n'); await Promise.race([closed, delay(10000).then(() => child.kill())]); }
    for (const pid of pids()) if (alive(pid)) { try { process.kill(pid); } catch {} }
  }
});

test('App batch mode preserves fresh-build ordering, bypasses user env and dispatches only the dedicated seed entry', () => {
  const bat = readFileSync(resolve('start.bat'), 'utf8'), wrapper = readFileSync(resolve('start-app-demo.bat'), 'utf8');
  assert.match(wrapper, /call "%~dp0start\.bat" app-demo/i);
  assert.match(bat, /if defined DOOGY_APP_DEMO_LAUNCH goto dependencies/i);
  assert.ok(bat.indexOf('call npm.cmd run build') < bat.indexOf('if defined DOOGY_APP_DEMO_LAUNCH goto app_demo'));
  assert.match(bat, /call npm\.cmd run build\r?\nif errorlevel 1 goto failed/);
  assert.match(bat, /:app_demo\r?\n[^\r\n]*\r?\nnode dist\/scripts\/app-demo\.js\r?\nif errorlevel 1 goto failed/i);
  const block = bat.match(/:app_demo\r?\n([\s\S]*?)(?:\r?\n:|$)/)?.[1]; assert.ok(block);
  assert.equal(block.includes('--env-file='), false);
});
