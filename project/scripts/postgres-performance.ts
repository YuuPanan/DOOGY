import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { DevicesService, provisionDevice } from '../src/devices';
import { FencesService } from '../src/fences';
import { TelemetryService } from '../src/telemetry';
import { NotificationService } from '../src/notifications';

const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const round = (n: number) => Math.round(n * 100) / 100;
export function latencyStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? round(sorted[Math.ceil(sorted.length * p) - 1]) : null;
  return { count: sorted.length, p50_ms: percentile(.5), p95_ms: percentile(.95), p99_ms: percentile(.99), max_ms: percentile(1) };
}
type Pet = { owner: string; token: string; id: string; device: string; deviceToken: string; binding: string };
type Process = { child: ChildProcess; closed: Promise<void>; wait: (pattern: RegExp) => Promise<RegExpMatchArray> };

async function runBenchmark(urlInput: string, quick: boolean, reportFile: string) {
  const url = new URL(urlInput);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required');
  assert.ok(!url.searchParams.has('database') && !url.searchParams.has('dbname'), 'Put the database in the URL path');
  const name = `doogy_perf_${randomUUID().replace(/-/g, '')}`;
  const target = new URL(url); target.pathname = `/${name}`;
  const admin = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const processes: Process[] = [], checks: { name: string; passed: boolean; actual: unknown }[] = [];
  const households = quick ? 4 : 20, history = quick ? 30 : 1000, seconds = quick ? .7 : 6;
  const report: Row = { format: 'doogy-postgres-performance-v1', profile: quick ? 'quick' : 'trial', started_at: new Date().toISOString(),
    machine: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logical_cpus: cpus().length, host_memory_gib: round(totalmem() / 1024 ** 3) },
    workload: { households, pets: households, historical_locations: households * history, track_page_size: 100, read_concurrency: quick ? [1, 4] : [1, 10, 30],
      read_seconds_per_level: seconds, worker_process_counts: [1, 3], unique_events_per_worker_phase: households * 10, duplicate_submissions_per_phase: households * 2,
      read_model: 'closed-loop HTTP, latest/track/overview round robin', write_model: 'burst, one sequential producer per device, 10 location messages and 2 exact retries', external_mode: 'offline' },
    transaction_mode: 'database advisory lock; write transactions remain serialized', reads: [], workers: [], checks, cleanup: false, passed: false };
  let db: Db | undefined, created = false;
  process.env.DATA_MODE = 'offline';

  function launch(role: 'API' | 'WORKER'): Process {
    const child = spawn(process.execPath, [resolve('dist/src', role === 'API' ? 'main.js' : 'worker-main.js')], {
      env: { ...process.env, DATABASE_URL: target.toString(), DB_DRIVER: 'postgres', DATA_MODE: 'offline', PORT: '0', HOST: '127.0.0.1' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let output = '', exited = false;
    child.stdout!.on('data', chunk => { output = (output + chunk).slice(-10000); });
    child.stderr!.resume();
    const closed = new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', () => { exited = true; done(); }); });
    const wait = async (pattern: RegExp) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const match = output.match(pattern); if (match) return match;
        if (exited) throw new Error(`PERF_${role}_EXITED_BEFORE_READY`);
        await pause(40);
      }
      throw new Error(`PERF_${role}_READY_TIMEOUT`);
    };
    const result = { child, closed, wait }; processes.push(result); return result;
  }
  async function stop(run: Process) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) { await run.closed; return; }
    if (run.child.connected) run.child.send('shutdown');
    const clean = await Promise.race([run.closed.then(() => true), pause(9000).then(() => false)]);
    if (!clean) { run.child.kill(); await run.closed; throw new Error('PERF_CHILD_FORCED_STOP'); }
    assert.equal(run.child.exitCode, 0, 'PERF_CHILD_EXIT_FAILED');
  }
  function check(label: string, passed: boolean, actual: unknown) { checks.push({ name: label, passed, actual }); }

  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    db = await Db.open({ driver: 'postgres', url: target.toString() });
    report.database = await db.get("SELECT current_setting('server_version') AS postgres,postgis_version() AS postgis,current_setting('max_connections') AS max_connections");
    const identity = new IdentityService(db), devices = new DevicesService(db), notifications = new NotificationService(db);
    const telemetry = new TelemetryService(db, devices, notifications), pets: Pet[] = [];
    console.log(`[PERF] Seeding ${households} synthetic households and ${households * history} historical locations.`);
    for (let i = 0; i < households; i++) {
      const owner = await identity.register({ email: `perf-${i}@example.invalid`, password: 'Synthetic-performance-2026' });
      const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Synthetic performance pet' });
      const device = await provisionDevice(db, { serial_no: `PERF-${i}` });
      await devices.claim(owner.user.id, { ...device, pet_id: pet.id });
      await new FencesService(db).create(owner.user.id, { pet_id: pet.id, name: 'Synthetic fence', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 10 }, buffer_m: 0 });
      const binding = (await db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', device.device_id))!.id;
      pets.push({ owner: owner.user.id, token: owner.access_token, id: pet.id, device: device.device_id, deviceToken: device.device_token, binding });
      // Historical fixtures exercise real indexes without charging setup replay to the timed workload.
      await db.run(`INSERT INTO device_events(event_id,device_id,pet_id,binding_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,process_status,next_attempt_at,processed_at)
        SELECT md5(?||n::text)::uuid::text,?,?,?,'location.reported',stamp,stamp,n,'perf-history','{}','{}','processed',stamp,stamp
        FROM (SELECT n,to_char((NOW()-INTERVAL '10 minutes'-n*INTERVAL '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stamp FROM generate_series(1,?) n) h`,
      device.device_id, device.device_id, pet.id, binding, history);
      await db.run(`INSERT INTO locations(id,event_id,device_id,pet_id,device_ts,received_at,lat,lon,accuracy_m,source,seq,boot_id,quality_flags_json)
        SELECT event_id,event_id,device_id,pet_id,device_ts,received_at,31.23,121.47,1,'gnss',seq,boot_id,'[]' FROM device_events WHERE device_id=?`, device.device_id);
    }
    await db.exec('ANALYZE');
    async function insideBaseline(phase: string) {
      await pause(1200);
      const time = Date.now() - 1800;
      for (let seq = 0; seq < 2; seq++) {
        for (const pet of pets) await telemetry.ingest({ schema_version: '1.0', event_id: randomUUID(), device_id: pet.device, boot_id: `baseline-${phase}`, seq,
          event_type: 'location.reported', device_ts: new Date(time + seq * 500).toISOString(), payload: { lat: 31.23, lon: 121.47, source: 'gnss', accuracy_m: 1, battery_pct: 80 } }, pet.deviceToken);
        await telemetry.work(households * 2);
      }
      await notifications.dispatch(households * 4);
      assert.equal((await db!.get("SELECT COUNT(*) AS n FROM geofence_states WHERE status='inside'"))!.n, households, 'PERF_BASELINE_INSIDE');
    }
    await insideBaseline('read');
    const api = launch('API'), ready = await api.wait(/DOOGY API (http:\/\/\S+) \| Swagger/), base = ready[1];
    async function request(path: string, pet: Pet, body?: unknown) {
      const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json', 'x-device-token': pet.deviceToken } : { authorization: `Bearer ${pet.token}` },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, body ? 202 : 200, 'PERF_HTTP_STATUS'); return response.json() as Promise<Row>;
    }
    const endpoint = (kind: number, pet: Pet) => kind === 0 ? `/pets/${pet.id}/location/latest` : kind === 1 ? `/pets/${pet.id}/locations?limit=100` : `/pets/${pet.id}/overview`;
    const warmup: number[] = [];
    for (const pet of pets) { const t = performance.now(); await request(endpoint(2, pet), pet); warmup.push(performance.now() - t); }
    report.cold_overview = latencyStats(warmup);
    async function readLoad(concurrency: number, active: () => boolean) {
      const values: number[][] = [[], [], []], errors: number[] = [0, 0, 0];
      let ordinal = 0;
      const start = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (active()) {
          const n = ordinal++, kind = n % 3, pet = pets[n % pets.length], t = performance.now();
          try { await request(endpoint(kind, pet), pet); values[kind].push(performance.now() - t); }
          catch { errors[kind]++; }
        }
      }));
      const elapsed = performance.now() - start;
      return { concurrency, duration_ms: round(elapsed), requests_per_second: round(values.flat().length * 1000 / elapsed),
        endpoints: ['latest', 'track_100', 'overview'].map((name, n) => ({ name, ...latencyStats(values[n]), errors: errors[n] })) };
    }
    for (const concurrency of report.workload.read_concurrency) {
      console.log(`[PERF] HTTP reads: concurrency=${concurrency}, ${seconds}s.`);
      const until = performance.now() + seconds * 1000, result = await readLoad(concurrency, () => performance.now() < until);
      report.reads.push(result);
      for (const item of result.endpoints) check(`read_${concurrency}_${item.name}_p95_under_500ms`, item.count > 0 && item.errors === 0 && item.p95_ms! < 500, item);
    }
    report.speed_reference_plan = await db.get(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT l.id FROM locations l JOIN device_events e ON e.event_id=l.event_id
      WHERE l.device_id=? AND e.binding_id=? AND l.device_ts<? AND l.source='gnss' AND l.accuracy_m<=100 AND l.quality_flags_json='[]'
      ORDER BY l.device_ts DESC,l.id DESC LIMIT 1`, pets[0].device, pets[0].binding, new Date().toISOString());
    // Summarize plans without recording query literals, IDs or location data.
    const plan = report.speed_reference_plan['QUERY PLAN'][0];
    const nodes: Row[] = [];
    function visit(node: Row) { nodes.push({ type: node['Node Type'], index: node['Index Name'], actual_rows: node['Actual Rows'], buffers_hit: node['Shared Hit Blocks'] }); for (const child of node.Plans ?? []) visit(child); }
    visit(plan.Plan); report.speed_reference_plan = { execution_ms: plan['Execution Time'], nodes };
    for (const count of [1, 3]) {
      console.log(`[PERF] Mixed HTTP + ${count} real Worker process(es), ${households * 10} unique events and retries.`);
      await insideBaseline(`workers-${count}`);
      const workers = Array.from({ length: count }, () => launch('WORKER'));
      await Promise.all(workers.map(worker => worker.wait(/DOOGY worker started/)));
      const boot = `perf-live-${count}`, start = performance.now(), time = Date.now() - 100;
      let loading = true, maximumBacklog = 0, maximumLockWaiters = 0, maximumConnections = 0;
      const mixedReads = readLoad(quick ? 2 : 10, () => loading);
      const monitoring = (async () => {
        while (loading) {
          const row = await db!.get(`SELECT COUNT(*) FILTER (WHERE process_status<>'processed') AS pending FROM device_events WHERE boot_id=?`, boot);
          const locks = await db!.get(`SELECT COUNT(*) AS connections,COUNT(*) FILTER (WHERE wait_event='advisory') AS waiting
            FROM pg_stat_activity WHERE datname=current_database() AND application_name='doogy-backend'`);
          maximumBacklog = Math.max(maximumBacklog, row!.pending); maximumLockWaiters = Math.max(maximumLockWaiters, locks!.waiting); maximumConnections = Math.max(maximumConnections, locks!.connections);
          await pause(200);
        }
      })();
      const ingress: number[] = [];
      try {
        await Promise.all(pets.map(async pet => {
          for (let seq = 0; seq < 10; seq++) {
            const event = { schema_version: '1.0', event_id: randomUUID(), device_id: pet.device, boot_id: boot, seq,
              device_ts: new Date(time + seq).toISOString(), event_type: 'location.reported',
              payload: { lat: 31.2302, lon: 121.47, accuracy_m: 1, source: 'gnss', battery_pct: 80 } };
            const t = performance.now(); await request('/ingest/events', pet, event); ingress.push(performance.now() - t);
            if (seq % 5 === 0) assert.equal((await request('/ingest/events', pet, event)).duplicate, true, 'PERF_RETRY_IDENTITY');
          }
        }));
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          const pending = (await db.get("SELECT COUNT(*) AS n FROM device_events WHERE boot_id=? AND process_status<>'processed'", boot))!.n;
          const unsent = (await db.get("SELECT COUNT(*) AS n FROM notifications WHERE status NOT IN ('simulated','skipped')"))!.n;
          if (!pending && !unsent) break;
          await pause(100);
        }
      } finally { loading = false; }
      const mixed = await mixedReads; await monitoring;
      const elapsed = performance.now() - start;
      const rows = await db.all('SELECT event_id,device_id,device_ts,received_at,processing_started_at,processed_at,process_status,attempts FROM device_events WHERE boot_id=?', boot);
      const completed = rows.filter(row => row.process_status === 'processed');
      const alerts = await db.all(`SELECT e.received_at,e.processed_at,n.status FROM safety_events s JOIN locations l ON l.id=s.location_id
        JOIN device_events e ON e.event_id=l.event_id JOIN notifications n ON n.event_id=s.id WHERE e.boot_id=? AND s.type='geofence.exited'`, boot);
      const projection = latencyStats(completed.map(row => Date.parse(row.processed_at) - Date.parse(row.received_at)));
      const queue = latencyStats(completed.map(row => Date.parse(row.processing_started_at) - Date.parse(row.received_at)));
      const alertCompletion = latencyStats(alerts.map(row => Date.parse(row.processed_at) - Date.parse(row.received_at)));
      const locationCount = (await db.get('SELECT COUNT(*) AS n FROM locations WHERE boot_id=?', boot))!.n;
      let latestCorrect = true;
      for (const pet of pets) {
        const latest = await db.get('SELECT l.device_ts FROM device_state s JOIN locations l ON l.id=s.last_location_id WHERE s.device_id=?', pet.device);
        latestCorrect &&= latest?.device_ts === new Date(time + 9).toISOString();
      }
      const result = { worker_processes: count, duration_ms: round(elapsed), processed_per_second: round(completed.length * 1000 / elapsed),
        ingress: latencyStats(ingress), queue_wait: queue, accepted_to_projection_complete: projection,
        rule_satisfying_event_to_projection_complete: alertCompletion, mixed_reads: mixed,
        sampled_max_backlog: maximumBacklog, sampled_max_advisory_waiters: maximumLockWaiters, sampled_max_connections: maximumConnections,
        unique_events: rows.length, projected_locations: locationCount, completed: completed.length, retries_or_dead: rows.filter(row => row.attempts > 0 || row.process_status !== 'processed').length,
        exit_events_and_notifications: alerts.length, notifications_simulated: alerts.filter(row => row.status === 'simulated').length, latest_correct: latestCorrect };
      report.workers.push(result);
      check(`workers_${count}_exactly_once_and_queue_drained`, rows.length === households * 10 && completed.length === rows.length && locationCount === rows.length && result.retries_or_dead === 0 && latestCorrect, { unique: rows.length, locations: locationCount, complete: completed.length, latest_correct: latestCorrect });
      check(`workers_${count}_projection_p95_under_10s`, projection.count === households * 10 && projection.p95_ms! < 10000, projection);
      check(`workers_${count}_rule_projection_p95_under_30s`, alerts.length === households && result.notifications_simulated === households && alertCompletion.p95_ms! < 30000, alertCompletion);
      for (const item of mixed.endpoints) check(`workers_${count}_${item.name}_p95_under_500ms`, item.count > 0 && item.errors === 0 && item.p95_ms! < 500, item);
      await Promise.all(workers.map(stop));
    }
    const stats = await db.get('SELECT deadlocks,temp_bytes,blks_read,blks_hit FROM pg_stat_database WHERE datname=current_database()');
    report.database_statistics = stats;
    check('no_database_deadlocks', Number(stats!.deadlocks) === 0, stats!.deadlocks);
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'PERF_FAILED';
  } finally {
    const stopped = await Promise.allSettled(processes.map(stop));
    report.owned_processes_stopped = stopped.every(result => result.status === 'fulfilled');
    if (db) await db.close();
    try {
      if (created) {
        assert.match(name, /^doogy_perf_[a-f0-9]{32}$/);
        for (let i = 0; i < 100; i++) {
          const live = (await admin.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [name])).rows[0].n;
          if (!live) break; await pause(25);
        }
        await admin.query(`DROP DATABASE "${name}"`);
      }
      report.cleanup = true;
    } catch { report.cleanup = false; report.cleanup_database = name; }
    await admin.end();
    report.finished_at = new Date().toISOString();
    report.passed = !report.error && report.cleanup && report.owned_processes_stopped && checks.length > 0 && checks.every(item => item.passed);
    mkdirSync(dirname(resolve(reportFile)), { recursive: true });
    writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ report: resolve(reportFile), passed: report.passed, failed_checks: checks.filter(item => !item.passed).map(item => item.name), error: report.error, cleanup: report.cleanup }));
  return report;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2), quick = args.includes('--quick'), reportIndex = args.indexOf('--report');
    assert.ok(args.every((arg, index) => arg === '--quick' || arg === '--report' || index === reportIndex + 1 && reportIndex >= 0), 'Usage: postgres:perf -- [--quick] [--report file.json]');
    const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required');
    const filename = reportIndex >= 0 ? args[reportIndex + 1] : `data/performance/postgres-${Date.now()}.json`;
    assert.ok(filename, '--report requires a new output file');
    const report = await runBenchmark(url, quick, filename);
    if (!report.passed) process.exitCode = 1;
  })().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
