import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { seedMvpDemo, availablePort } from './mvp-demo';
import { AssistantService } from '../src/assistant';
import { BehaviorService } from '../src/behavior';
import { CareService, activityWindow } from '../src/care';
import { ContactAlertsService } from '../src/contact-alerts';
import { importContent } from '../src/content';
import { ContactsService } from '../src/contacts';
import { Db } from '../src/db';
import { ObservationsService } from '../src/observations';
import { ProfileService } from '../src/profile';
import { WellnessService } from '../src/wellness';

export async function seedAppDemo(db: Db) {
  if ((process.env.DATA_MODE ?? 'offline') !== 'offline') throw new Error('App 合成演示仅支持 offline');
  if ((await db.get('SELECT COUNT(*) AS n FROM users'))!.n || (await db.get('SELECT COUNT(*) AS n FROM content_items'))!.n) throw new Error('App 演示需要空数据库，不会向已有业务库导入内容');
  const demo = await seedMvpDemo(db), owner = (await db.get('SELECT id FROM users WHERE email=?', demo.owner.email))!;
  const catalog = JSON.parse(readFileSync(resolve('fixtures/app-demo-content.json'), 'utf8'));
  await importContent(db, catalog);
  const care = new CareService(db), wellness = new WellnessService(db), contacts = new ContactsService(db);
  const behavior = new BehaviorService(db), assistant = new AssistantService(db), profiles = new ProfileService(db);
  const now = db.now(), today = activityWindow(undefined, 'Asia/Shanghai', db.clock());
  const note = '合成演示：仅供软件流程测试，不代表真实宠物、食品或专业建议。';
  const feeding = await care.create(owner.id, { pet_id: demo.pet_id, type: 'feeding', recorded_at: now, notes: note,
    value: { schema_version: 'feeding-v1', food_name: '合成演示食品（非真实食品）', category: 'synthetic', amount: 10, unit: 'g', meal_type: 'meal',
      label_energy: { kcal: 40, per_amount: 10, unit: 'g', source: '合成演示标签，只用于验证保存与汇总' } } });
  const toileting = await db.get("SELECT id FROM care_records WHERE pet_id=? AND type='toileting'", demo.pet_id);
  const body = await wellness.putCheckIn(owner.id, demo.pet_id, { date: today.date, timezone: today.timezone }, {
    expected_version: 0, values: { appetite: '合成演示：食欲输入原文', energy: '合成演示：精力输入原文', movement: '合成演示：活动输入原文', stool: '合成演示：排便输入原文' },
    notes: note, toileting_record_id: toileting?.id ?? null, observed_at: now });
  const plan = catalog.items.find((item: any) => item.kind === 'plan');
  const goals = await wellness.putGoals(owner.id, demo.pet_id, { effective_date: today.date, expected_version: 0,
    targets: { active_minutes: null, steps: null, intake_kcal: null }, source: 'synthetic_demo',
    plan: { name: plan.content.title, content_version: `${plan.id}@${plan.content_version}`, ...plan.content.exercise_plan } });
  const assessment = await new ObservationsService(db, care).get(owner.id, demo.pet_id, { timezone: today.timezone });

  // Constructed one-second PCM silence, not a validator/decoder acceptance claim.
  const bytes = Buffer.alloc(16044); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
  const mediaId = db.id(), captured = new Date(db.clock().getTime() - 2000).toISOString(), end = new Date(db.clock().getTime() - 1000).toISOString();
  await db.run(`INSERT INTO pet_media(id,pet_id,filename,content_type,size_bytes,sha256,content_base64,duration_seconds,captured_at,source,created_by,created_at,validation_json)
    VALUES (?,?,?,?,?,?,?,?,?,'synthetic',?,?,?)`, mediaId, demo.pet_id, 'synthetic-demo-silence.wav', 'audio/wav', bytes.length,
    createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), 1, captured, owner.id, now,
    JSON.stringify({ method: 'synthetic_fixture', note: 'Constructed PCM silence; no decoder or model was run.' }));
  const record = await behavior.createRecord(owner.id, demo.pet_id, { labels: ['合成演示人工标签'], start_at: captured, end_at: end, media_id: mediaId, notes: note });
  const interpretation = await behavior.createInterpretation(owner.id, demo.pet_id, { media_id: mediaId, behavior_record_id: record.id, notes: note });
  const conversation = await assistant.createConversation(owner.id, demo.pet_id, { title: '合成演示 · 问题保存与固定演示' });
  const message = await assistant.postMessage(owner.id, conversation.id, { question: '合成演示：请展示问题保存、上下文引用与离线固定演示流程。', context: { kind: 'nutrition', date: today.date, timezone: today.timezone, notes: note } });
  const granted = await contacts.create(owner.id, demo.household_id, { name: '合成演示联系人（仅成员报告同意）', email: 'granted@doogy-demo.example.invalid',
    purpose: '合成演示，不发送真实消息', is_primary: true, consent: { status: 'reported_granted', note: '合成成员报告，未核验本人同意' } });
  const unknown = await contacts.create(owner.id, demo.household_id, { name: '合成演示联系人（尚无同意）', email: 'unknown@doogy-demo.example.invalid', purpose: '合成演示：查看未同意失败原因' });
  const alert = await new ContactAlertsService(db).create(owner.id, demo.pet_id, { message: '合成演示文字通知：没有真实发送，没有位置或分享链接。', consent: true, expires_in_seconds: 3600,
    recipients: [granted, unknown].map(row => ({ contact_id: row.id, expected_version: row.version, method: 'email' })) });
  // Existing demo accounts enter Main; a newly registered account still starts the normal no-pet guide.
  await profiles.updateOnboarding(owner.id, { expected_version: 0, pet_id: demo.pet_id, collar_choice: 'completed', completed: true });
  const viewer = (await db.get('SELECT id FROM users WHERE email=?', demo.viewer.email))!;
  await profiles.updateOnboarding(viewer.id, { expected_version: 0, pet_id: demo.pet_id, collar_choice: 'completed', completed: true });
  return { ...demo, demo_kind: 'app_closed_loop', content_package: 'fixtures/app-demo-content.json', professional_advice: false,
    content: catalog.items.map((item: any) => ({ id: item.id, kind: item.kind, category: item.content.category, content_version: item.content_version })),
    examples: { feeding_id: feeding.id, body_check_in_id: body.id, goal_id: goals.id, assessment_id: assessment.id, media_id: mediaId,
      behavior_record_id: record.id, interpretation_id: interpretation.id, conversation_id: conversation.id, message_id: message.id, contact_ids: [granted.id, unknown.id], contact_alert_id: alert.id },
    boundaries: ['synthetic_only', 'no_real_model', 'no_real_delivery', 'no_real_hardware', 'media_not_decoder_validated', 'null_targets_are_unknown'],
    queued_work: ['interpretation', 'assistant_message', 'contact_alert'], local_date: today.date, timezone: today.timezone };
}

export async function main(args = process.argv.slice(2)) {
  const loopback = args.includes('--loopback'), values = args.filter(value => value !== '--loopback');
  if (values.length > 1 || args.filter(value => value === '--loopback').length > 1) throw new Error('Usage: app-demo [port] [--loopback]');
  const port = values.length ? Number(values[0]) : await availablePort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('演示端口应为 1–65535 的整数');
  const directory = resolve('data', `app-demo-${randomUUID().replace(/-/g, '')}`);
  mkdirSync(directory, { recursive: true });
  const environment = { HOST: loopback ? '127.0.0.1' : '0.0.0.0', PORT: String(port), DB_DRIVER: 'sqlite', DB_PATH: resolve(directory, 'doogy.db'),
    DATA_MODE: 'offline', DOOGY_DEMO: '1', MANAGED_BACKUP_ENABLED: 'false', FRESH_SECONDS: '1800', OFFLINE_SECONDS: '1800' };
  Object.assign(process.env, environment);
  for (const key of ['DATABASE_URL', 'PUSH_WEBHOOK_URL', 'PUSH_WEBHOOK_TOKEN', 'VENDOR_WEBHOOK_SECRET', 'SUPPORT_ADMIN_USER_IDS', 'DEVICE_ADMIN_USER_IDS']) delete process.env[key];
  writeFileSync(resolve(directory, 'demo.env'), Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\r\n') + '\r\n');
  const db = await Db.open({ driver: 'sqlite', path: environment.DB_PATH });
  let demo;
  try { demo = await seedAppDemo(db); } finally { await db.close(); }
  const addresses = loopback ? [] : [...new Set(Object.values(networkInterfaces()).flat().filter(address => address?.family === 'IPv4' && !address.internal).map(address => address!.address))];
  const roots = { localhost: `http://127.0.0.1:${port}`, emulator: `http://10.0.2.2:${port}`, lan: addresses.map(address => `http://${address}:${port}`) };
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify({ ...demo, directory, environment, api_roots: roots }, null, 2) + '\n');
  console.log('\n[DOOGY APP DEMO] Synthetic data only / 账号、内容、定位、媒体、目标和通知均为合成演示；不是专业建议。');
  console.log(`[DOOGY APP DEMO] 数据保存在独立目录：${directory}`);
  console.log(`[DOOGY APP DEMO] 主人账号：${demo.owner.email}  密码：${demo.owner.password}`);
  console.log(`[DOOGY APP DEMO] 只读账号：${demo.viewer.email}  密码：${demo.viewer.password}`);
  console.log(`[DOOGY APP DEMO] 本机根地址：${roots.localhost}`);
  if (!loopback) {
    console.log(`[DOOGY APP DEMO] Android 模拟器根地址：${roots.emulator}`);
    for (const address of roots.lan) console.log(`[DOOGY APP DEMO] 手机根地址候选：${address}`);
    console.log('[DOOGY APP DEMO] 本入口显式监听局域网，固定凭据仅供可信局域网合成测试；手机须与电脑网络可达，防火墙放行由用户管理。');
    if (!roots.lan.length) console.log('[DOOGY APP DEMO] 未发现非回环IPv4，手机地址需按电脑实际网络配置确认。');
  }
  console.log('[DOOGY APP DEMO] App登录页填写根地址（不带/api/v1）；API + Worker处理固定离线演示，无模型调用或真实发送。');
  console.log('[DOOGY APP DEMO] 每次创建新库，不读取或导入用户.env，不删除旧演示；可注册新账号体验无宠物引导。\n');
  await import('./start');
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
