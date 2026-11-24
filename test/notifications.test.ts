import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Db, Row } from '../src/db';
import { NotificationService } from '../src/notifications';

beforeEach(() => {
  process.env.DATA_MODE = 'offline';
  process.env.PUSH_MODE = 'mock';
  delete process.env.PUSH_WEBHOOK_URL;
  delete process.env.PUSH_WEBHOOK_TOKEN;
});

async function fixture() {
  let time = Date.parse('2026-11-17T02:00:00Z');
  const db = new Db(':memory:', () => new Date(time));
  const user = db.id(), viewer = db.id(), household = db.id(), pet = db.id(), device = db.id(), event = db.id();
  for (const id of [user, viewer]) await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', id, `${id}@test.invalid`, 'unused', db.now());
  await db.run('INSERT INTO households VALUES (?,?,?,?)', household, 'Home', user, db.now());
  await db.run('INSERT INTO household_members VALUES (?,?,?,?)', household, user, 'owner', db.now());
  await db.run('INSERT INTO pets(id,household_id,name,species,created_at,updated_at) VALUES (?,?,?,?,?,?)', pet, household, 'Doogy', 'dog', db.now(), db.now());
  await db.run('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', device, device, 'test', 'test', 'test', db.now());
  await db.run('INSERT INTO safety_events(id,pet_id,device_id,type,occurred_at,details_json) VALUES (?,?,?,?,?,?)', event, pet, device, 'geofence.exited', db.now(), '{"lat":31,"lon":121}');
  return { db, user, viewer, household, pet, device, event, service: new NotificationService(db), advance: (ms: number) => { time += ms; } };
}

test('enqueue is idempotent, respects preferences, supports unread and hides cross-household records', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  await f.db.run('INSERT INTO household_members VALUES (?,?,?,?)', f.household, f.viewer, 'viewer', f.db.now());
  await f.service.updatePreferences(f.viewer, { geofence: false });
  await f.service.enqueue(f.event); await f.service.enqueue(f.event);
  assert.equal((await f.db.get('SELECT COUNT(*) AS total FROM notifications'))!.total, 1);
  const list = await f.service.list(f.user, { unread: 'true', limit: 1 });
  assert.equal(list.items.length, 1);
  assert.equal((await f.service.list(f.viewer, {})).items.length, 0);
  const id = list.items[0].id;
  await assert.rejects(async () => await f.service.markRead(f.viewer, id));
  await f.service.markRead(f.user, id);
  assert.equal((await f.service.list(f.user, { unread: 'true' })).items.length, 0);
  assert.equal((await f.service.list(f.user, { unread: 'false' })).items.length, 1);
});

test('offline dispatch records simulation distinctly from delivery', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  await f.service.enqueue(f.event);
  assert.equal(await f.service.dispatch(), 1);
  const row = (await f.service.list(f.user, {})).items[0];
  assert.equal(row.status, 'simulated');
  assert.equal(row.retry_count, 0);
  assert.ok(row.provider_message_id.startsWith('mock:'));
  assert.equal(await f.service.dispatch(), 0);
});

test('offline mode never sends to a leftover configured webhook', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  class MustNotSend extends NotificationService { protected async deliver(): Promise<string> { assert.fail('offline mode attempted network delivery'); } }
  process.env.PUSH_MODE = 'webhook'; process.env.PUSH_WEBHOOK_URL = 'https://push.invalid/send'; process.env.PUSH_WEBHOOK_TOKEN = 'leftover-token';
  const sender = new MustNotSend(f.db);
  await sender.enqueue(f.event);
  assert.equal(await sender.dispatch(), 1);
  assert.equal((await sender.list(f.user, {})).items[0].status, 'simulated');
});

test('API mode never simulates even with PUSH_MODE=mock and leaves unconfigured work pending', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  process.env.DATA_MODE = 'api';
  await f.service.enqueue(f.event);
  assert.equal(await f.service.dispatch(), 0);
  const row = (await f.service.list(f.user, {})).items[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.retry_count, 0);
  assert.equal(row.provider_message_id, null);
});

test('revoked membership or disabled preference cancels pending push and access', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  await f.db.run('INSERT INTO household_members VALUES (?,?,?,?)', f.household, f.viewer, 'viewer', f.db.now());
  await f.service.enqueue(f.event);
  await f.db.run('DELETE FROM household_members WHERE user_id=?', f.viewer);
  await f.service.updatePreferences(f.user, { geofence: false });
  assert.equal(await f.service.dispatch(), 2);
  assert.deepEqual((await f.db.all('SELECT error FROM notifications ORDER BY error')).map(x => x.error), ['ACCESS_REVOKED', 'PREFERENCE_DISABLED']);
  assert.equal((await f.service.list(f.viewer, {})).items.length, 0);
});

test('push-token registration transfers an app installation and tokens stay out of responses', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  const one = await f.service.registerToken(f.user, { platform: 'ios', token: 'push-token-private' });
  const two = await f.service.registerToken(f.viewer, { platform: 'android', token: 'push-token-private' });
  assert.equal(one.id, two.id);
  assert.equal('token' in two, false);
  await assert.rejects(async () => await f.service.removeToken(f.user, one.id));
  assert.equal((await f.service.removeToken(f.viewer, one.id)).deleted, true);
});

test('real webhook sends minimal authenticated idempotent payload and stores provider result', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  let payload: Row = {}, headers: Row = {};
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      payload = JSON.parse(Buffer.concat(chunks).toString()); headers = request.headers;
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"message_id":"provider:123"}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  process.env.DATA_MODE = 'api'; process.env.PUSH_WEBHOOK_TOKEN = 'webhook-secret';
  process.env.PUSH_WEBHOOK_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/push`;
  await f.service.registerToken(f.user, { platform: 'ios', token: 'installation:abc' });
  await f.service.enqueue(f.event);
  assert.equal(await f.service.dispatch(), 1);
  const row = (await f.service.list(f.user, {})).items[0];
  assert.equal(row.status, 'sent'); assert.equal(row.provider_message_id, 'provider:123');
  assert.equal(headers.authorization, 'Bearer webhook-secret');
  assert.equal(headers['idempotency-key'], row.id);
  assert.deepEqual(Object.keys(payload).sort(), ['event_id', 'notification_id', 'tokens', 'type', 'user_id']);
  assert.equal(JSON.stringify(payload).includes('"lat"'), false);
});

test('failed delivery backs off, becomes dead after five attempts, then can be requeued', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  class FailingSender extends NotificationService { protected async deliver(): Promise<string> { throw new Error('secret-provider-response'); } }
  const sender = new FailingSender(f.db);
  process.env.DATA_MODE = 'api'; process.env.PUSH_WEBHOOK_URL = 'https://push.invalid/send'; process.env.PUSH_WEBHOOK_TOKEN = 'test';
  await sender.registerToken(f.user, { platform: 'android', token: 'installation:abc' }); await sender.enqueue(f.event);
  for (let i = 1; i <= 5; i++) {
    assert.equal(await sender.dispatch(), 1);
    const row = (await sender.list(f.user, {})).items[0];
    assert.equal(row.retry_count, i);
    assert.equal(row.error, 'PUSH_DELIVERY_FAILED');
    assert.equal(row.status, i === 5 ? 'dead' : 'pending');
    assert.equal(await sender.dispatch(), 0);
    f.advance(3600_000);
  }
  const row = (await sender.list(f.user, {})).items[0];
  await assert.rejects(async () => await sender.retryDead(f.viewer, row.id));
  await sender.retryDead(f.user, row.id);
  assert.equal((await sender.list(f.user, {})).items[0].retry_count, 0);
});

test('unexpired lease blocks duplicate work and expired lease is recovered', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  await f.service.enqueue(f.event);
  await f.db.run("UPDATE notifications SET status='processing',lease_until=?", new Date(f.db.clock().getTime() + 30_000).toISOString());
  assert.equal(await f.service.dispatch(), 0);
  f.advance(31_000);
  assert.equal(await f.service.dispatch(), 1);
  assert.equal((await f.service.list(f.user, {})).items[0].status, 'simulated');
});

test('a late worker cannot overwrite a reclaimed notification delivery result', async t => {
  const f = await fixture(); t.after(async () => await f.db.close());
  let rejectFirst!: (error: Error) => void;
  let entered!: () => void;
  const deliveryStarted = new Promise<void>(resolve => { entered = resolve; });
  class DelayedSender extends NotificationService {
    protected deliver(): Promise<string> { return new Promise((_, reject) => { rejectFirst = reject; entered(); }); }
  }
  class SuccessfulSender extends NotificationService { protected async deliver() { return 'provider:recovered'; } }
  process.env.DATA_MODE = 'api'; process.env.PUSH_WEBHOOK_URL = 'https://push.invalid/send'; process.env.PUSH_WEBHOOK_TOKEN = 'test';
  await f.service.registerToken(f.user, { platform: 'ios', token: 'installation:abc' }); await f.service.enqueue(f.event);
  const pending = new DelayedSender(f.db).dispatch(1);
  await deliveryStarted;
  f.advance(31_000);
  assert.equal(await new SuccessfulSender(f.db).dispatch(1), 1);
  rejectFirst(new Error('old request failed after its lease expired'));
  await pending;
  const row = (await f.service.list(f.user, {})).items[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.provider_message_id, 'provider:recovered');
  assert.equal(row.retry_count, 0);
});

test('并发偏好修改和终端注册保持完整结果，不丢失更新或返回不存在的终端ID', async t => {
  const f = await fixture(); t.after(async () => { await f.db.close(); });
  await Promise.all([
    f.service.updatePreferences(f.user, { geofence: false }),
    f.service.updatePreferences(f.user, { offline: false })
  ]);
  const preferences = await f.service.preferences(f.user);
  assert.equal(preferences.geofence, false);
  assert.equal(preferences.offline, false);
  const [first, second] = await Promise.all([
    f.service.registerToken(f.user, { platform: 'ios', token: 'concurrent-installation' }),
    f.service.registerToken(f.viewer, { platform: 'android', token: 'concurrent-installation' })
  ]);
  assert.equal(first.id, second.id);
  assert.equal((await f.db.get('SELECT COUNT(*) AS total FROM push_tokens'))!.total, 1);
});
