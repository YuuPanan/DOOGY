import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, TestContext } from 'node:test';
import { BackupScheduler } from '../src/backup-scheduler';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 12_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error(label); await delay(25); }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'doogy-scheduler-'));
  const keys = ['MANAGED_BACKUP_ENABLED','MANAGED_BACKUP_DIRECTORY','MANAGED_BACKUP_KEEP_COUNT','MANAGED_BACKUP_INTERVAL_HOURS',
    'DB_DRIVER','DB_PATH','DATA_MODE','SCHEDULER_TEST_RESULT','SCHEDULER_TEST_STARTS','SCHEDULER_TEST_LOCK'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const schedulers: BackupScheduler[] = [];
  Object.assign(process.env, { MANAGED_BACKUP_ENABLED: 'true', MANAGED_BACKUP_DIRECTORY: join(directory,'bundles'), MANAGED_BACKUP_KEEP_COUNT: '2',
    MANAGED_BACKUP_INTERVAL_HOURS: '24', DB_DRIVER: 'sqlite', DB_PATH: join(directory,'source.db'), DATA_MODE: 'offline',
    SCHEDULER_TEST_RESULT: join(directory,'result.json'), SCHEDULER_TEST_STARTS: join(directory,'starts.txt'), SCHEDULER_TEST_LOCK: join(directory,'lock.sqlite') });
  t.after(async () => {
    for (const scheduler of schedulers) await scheduler.stop();
    for (const [key,value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory,{recursive:true,force:true});
  });
  return { directory, scheduler: (entry: string) => { const scheduler = new BackupScheduler(entry); schedulers.push(scheduler); return scheduler; } };
}

test('自动备份默认关闭，不创建子进程或本地文件', async t => {
  const { directory, scheduler: createScheduler } = await fixture(t); delete process.env.MANAGED_BACKUP_ENABLED;
  const entry=join(directory,'disabled.cjs');
  await writeFile(entry, `require('node:fs').writeFileSync(process.env.SCHEDULER_TEST_RESULT,'spawned'); console.log('{"status":"completed"}');`);
  const scheduler=createScheduler(entry);
  scheduler.tick(); await scheduler.stop();
  assert.equal(existsSync(process.env.SCHEDULER_TEST_RESULT!),false);
  assert.equal(existsSync(process.env.MANAGED_BACKUP_DIRECTORY!),false);
});

test('自动备份tick不等待真实SQLite任务，单进程执行且成功后按间隔跳过', {timeout:25_000}, async t => {
  const { directory, scheduler: createScheduler }=await fixture(t), db=new Db(process.env.DB_PATH!);
  await new IdentityService(db).register({email:'scheduler-synthetic@example.invalid',password:'Synthetic-scheduler-2026'}); await db.close();
  const sourceHash=createHash('sha256').update(await readFile(process.env.DB_PATH!)).digest('hex');
  const entry=join(directory,'scheduled-wrapper.cjs'), actual=resolve('dist/scripts/managed-backup.js');
  await writeFile(entry, `
const fs=require('node:fs'),{spawn}=require('node:child_process');
fs.appendFileSync(process.env.SCHEDULER_TEST_STARTS,'start\\n');
const child=spawn(process.execPath,[${JSON.stringify(actual)},'scheduled'],{env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
child.on('close',code=>{fs.writeFileSync(process.env.SCHEDULER_TEST_RESULT,JSON.stringify({code,stdout,stderr}));process.stdout.write(stdout);process.exitCode=code??1;});
`);
  const output:string[]=[], original=console.log; console.log=(...items:unknown[])=>{output.push(items.join(' '));}; t.after(()=>{console.log=original;});
  const first=createScheduler(entry);
  const started=Date.now(); first.tick(); first.tick();
  assert.ok(Date.now()-started<1000,'tick blocked on the backup');
  await until(()=>existsSync(process.env.SCHEDULER_TEST_RESULT!),'First scheduled backup did not finish');
  await first.stop();
  const initial=JSON.parse(await readFile(process.env.SCHEDULER_TEST_RESULT!,'utf8'));
  assert.equal(initial.code,0,initial.stderr); assert.equal(JSON.parse(initial.stdout).status,'completed');
  assert.equal((await readFile(process.env.SCHEDULER_TEST_STARTS!,'utf8')).trim().split('\n').length,1);
  const files=(await readdir(process.env.MANAGED_BACKUP_DIRECTORY!,{recursive:true})).sort();
  process.env.SCHEDULER_TEST_RESULT=join(directory,'second-result.json');
  const second=createScheduler(entry); second.tick();
  await until(()=>existsSync(process.env.SCHEDULER_TEST_RESULT!),'Second scheduled backup did not finish'); await second.stop();
  const repeated=JSON.parse(await readFile(process.env.SCHEDULER_TEST_RESULT!,'utf8'));
  assert.equal(repeated.code,0,repeated.stderr); assert.equal(JSON.parse(repeated.stdout).status,'skipped');
  assert.deepEqual((await readdir(process.env.MANAGED_BACKUP_DIRECTORY!,{recursive:true})).sort(),files);
  assert.deepEqual(output,['[DOOGY] Managed backup completed']);
  assert.equal(createHash('sha256').update(await readFile(process.env.DB_PATH!)).digest('hex'),sourceHash);
});

test('自动备份失败只记录固定错误，不转发子进程原文或秘密', async t => {
  const { directory, scheduler: createScheduler }=await fixture(t), entry=join(directory,'failed.cjs');
  await writeFile(entry, `console.log('SYNTHETIC-PRIVATE-SOURCE'); console.error('SYNTHETIC-PRIVATE-CREDENTIAL'); process.exitCode=7;`);
  const errors:string[]=[], original=console.error; console.error=(...items:unknown[])=>{errors.push(items.join(' '));}; t.after(()=>{console.error=original;});
  const scheduler=createScheduler(entry); scheduler.tick();
  await until(()=>errors.length>0,'Scheduled failure was not reported'); await scheduler.stop();
  assert.deepEqual(errors,['[DOOGY] Managed backup failed (PROCESS_FAILED)']);
});

test('停止超时备份只清理自己的子孙进程，sidecar锁可由新连接重新取得', {timeout:20_000}, async t => {
  const { directory, scheduler: createScheduler }=await fixture(t), entry=join(directory,'stubborn.cjs');
  await writeFile(entry, `
const fs=require('node:fs'),{spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const lock=new DatabaseSync(process.env.SCHEDULER_TEST_LOCK);lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
fs.writeFileSync(process.env.SCHEDULER_TEST_RESULT,JSON.stringify({parent:process.pid,grandchild:grandchild.pid}));
process.on('message',()=>{});setInterval(()=>{},1000);
`);
  const scheduler=createScheduler(entry); scheduler.tick();
  await until(()=>existsSync(process.env.SCHEDULER_TEST_RESULT!),'Backup fixture did not acquire its lock');
  const pids=JSON.parse(readFileSync(process.env.SCHEDULER_TEST_RESULT!,'utf8')) as {parent:number;grandchild:number};
  t.after(()=>{for(const pid of [pids.parent,pids.grandchild])if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}});
  assert.ok(alive(pids.parent)&&alive(pids.grandchild));
  const competing=new DatabaseSync(process.env.SCHEDULER_TEST_LOCK!);
  try{assert.throws(()=>competing.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'),/locked/);}finally{competing.close();}
  await scheduler.stop(); await until(()=>!alive(pids.parent)&&!alive(pids.grandchild),'Owned backup process tree remains alive');
  const reopened=new DatabaseSync(process.env.SCHEDULER_TEST_LOCK!);
  try{reopened.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; COMMIT');}finally{reopened.close();}
});
