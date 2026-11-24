import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { AssistantService } from '../src/assistant';
import { importContent } from '../src/content';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`本人问答HTTP ${mode}：上下文来源、异步任务、重试取消、当前权限与导出失效`, async () => {
  process.env.DATA_MODE = mode;
  let now = Date.parse('2026-11-24T12:00:00Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db;
  const app = await createApp({ db, quiet: true }), worker = new AssistantService(db), originalFetch = globalThis.fetch;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    let external = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url;
      if (!url.startsWith(`${origin}/`)) { external++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, key?: string, expected = method === 'POST' ? 201 : 200, token = access) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    const password = 'Synthetic-assistant-2026';
    const register = (name: string) => api('/auth/register', 'POST', { email: `assistant-${name}-${mode}@example.invalid`, password, timezone: 'UTC' });
    const owner = await register('owner'), viewer = await register('viewer'), stranger = await register('stranger'); access = owner.access_token;
    const invite = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invite.token}/accept`, 'POST', undefined, undefined, 200, viewer.access_token);
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: '问答测试' });
    const otherPet = await api('/pets', 'POST', { household_id: owner.household.id, name: '另一宠物' });
    const conversationPath = `/pets/${pet.id}/assistant-conversations`;
    const conversation = await api(conversationPath, 'POST', { title: '显式上下文测试' }, 'conversation');
    assert.equal((await api(conversationPath, 'POST', { title: '显式上下文测试' }, 'conversation')).id, conversation.id);
    const messagesPath = `/assistant-conversations/${conversation.id}/messages`;
    await api(messagesPath, 'GET', undefined, undefined, 404, viewer.access_token);
    await api(conversationPath, 'GET', undefined, undefined, 404, stranger.access_token);
    const body = { question: '今天有哪些数据？', context: { kind: 'activity', date: '2026-11-24', timezone: 'UTC' } };
    const pending = await api(messagesPath, 'POST', body, 'message', 202);
    assert.equal(pending.status, 'pending'); assert.equal(pending.evidence.summary.steps, null);
    assert.equal(pending.evidence.used_by_model, false);
    assert.equal((await api(messagesPath, 'POST', body, 'message', 202)).id, pending.id);
    await api(messagesPath, 'POST', { ...body, question: '不同的问题' }, 'message', 409);
    assert.equal(await worker.work(), 1); assert.equal(await worker.work(), 0);
    const completed = await api(`/assistant-messages/${pending.id}`);
    if (mode === 'offline') {
      assert.equal(completed.status, 'succeeded'); assert.equal(completed.result.simulated, true);
      assert.equal(completed.model_version, null); assert.match(completed.result.text, /没有调用模型/);
    } else {
      assert.equal(completed.status, 'failed'); assert.equal(completed.error_code, 'MODEL_NOT_CONFIGURED'); assert.equal(completed.result, null);
      process.env.DATA_MODE = 'offline';
      const retry = await api(`/assistant-messages/${pending.id}/retry`, 'POST', { expected_attempt: 1 }, 'retry', 202);
      assert.equal(retry.attempt, 2); assert.equal(retry.captured_mode, 'offline');
      assert.equal((await api(`/assistant-messages/${pending.id}/retry`, 'POST', { expected_attempt: 1 }, 'retry', 202)).attempt, 2);
      await worker.work(); assert.equal((await api(`/assistant-messages/${pending.id}`)).result.simulated, true);
      process.env.DATA_MODE = mode;
    }
    const cancel = await api(messagesPath, 'POST', { question: '取消这个问题' }, undefined, 202);
    await api(`/assistant-messages/${cancel.id}/cancel`, 'POST', undefined, 'cancel', 200);
    assert.equal((await api(`/assistant-messages/${cancel.id}/cancel`, 'POST', undefined, 'cancel', 200)).status, 'cancelled');
    assert.equal(await worker.work(), 0);
    const checks = await api(`/pets/${pet.id}/body-check-ins?date=2026-11-24&timezone=UTC`, 'PUT', { expected_version: 0, values: { appetite: '主人原文' }, observed_at: '2026-11-24T03:00:00Z' });
    const checked = await api(messagesPath, 'POST', { question: '看一下我的记录', context: { kind: 'body_check_in', date: '2026-11-24', timezone: 'UTC' } }, undefined, 202);
    assert.equal(checked.evidence.check_in.id, checks.id); assert.equal(checked.evidence.check_in.values.energy, null);
    const meal = await api('/care-records', 'POST', { pet_id: pet.id, type: 'feeding', value: { food: '旧格式餐食' }, recorded_at: '2026-11-24T04:00:00Z' });
    let nutrition = await api(messagesPath, 'POST', { question: '餐食记录？', context: { kind: 'nutrition', date: '2026-11-24', timezone: 'UTC' } }, undefined, 202);
    assert.equal(nutrition.evidence.known_kcal, null); assert.deepEqual(nutrition.evidence.source_record_ids, [meal.id]);
    await api(`/care-records/${meal.id}`, 'PATCH', { value: { food: '更正后的餐食' } });
    const changedMeal = (await api('/auth/data-export/assistant_messages')).items.find((row: any) => row.id === nutrition.id);
    assert.equal(changedMeal.error_code, 'CARE_SOURCE_CHANGED'); assert.deepEqual(changedMeal.evidence, {});
    nutrition = await api(messagesPath, 'POST', { question: '更正后的餐食记录？', context: { kind: 'nutrition', date: '2026-11-24', timezone: 'UTC' } }, undefined, 202);
    await api(`/care-records/${meal.id}/withdraw`, 'POST', { reason: '重复录入' });
    const invalidMeal = await api(`/assistant-messages/${nutrition.id}`);
    assert.equal(invalidMeal.status, 'failed'); assert.deepEqual(invalidMeal.evidence, {});
    await api(`/assistant-messages/${nutrition.id}/retry`, 'POST', { expected_attempt: 1 }, undefined, 409);
    assert.notEqual((await api(`/assistant-messages/${checked.id}`)).status, 'failed', '无关餐食撤回不能删除体况上下文');
    const toilet = await api('/care-records', 'POST', { pet_id: pet.id, type: 'toileting', value: { kind: 'defecation' }, recorded_at: '2026-11-24T03:00:00Z' });
    await api(`/pets/${pet.id}/body-check-ins?date=2026-11-24&timezone=UTC`, 'PUT', { expected_version: 1, values: { stool: '主人观察' },
      observed_at: '2026-11-24T03:00:00Z', toileting_record_id: toilet.id });
    const linkedBody = await api(messagesPath, 'POST', { question: '引用排便手记', context: { kind: 'body_check_in', date: '2026-11-24', timezone: 'UTC' } }, undefined, 202);
    await api(`/care-records/${toilet.id}/withdraw`, 'POST', { reason: '排便记录有误' });
    const bodyExport = (await api('/auth/data-export/assistant_messages')).items.find((row: any) => row.id === linkedBody.id);
    assert.deepEqual(bodyExport.evidence, {}); assert.equal(bodyExport.status, 'failed');
    await api(`/assistant-messages/${linkedBody.id}/retry`, 'POST', { expected_attempt: 1 }, undefined, 409);
    assert.notEqual((await api(`/assistant-messages/${checked.id}`)).status, 'failed', '无排便引用的旧体况问答保持原始事实');

    const lessonId = db.id(), item = { id: lessonId, kind: 'lesson', content_version: 1, expected_revision: 0, status: 'published', content: {
      title: 'Synthetic source title', category: 'test', body: 'Synthetic content only', applicability: 'Tests only',
      sources: [{ title: 'Test source', reference: 'synthetic-only' }], review: { status: 'reviewed', reviewer: 'Synthetic reviewer', reviewed_at: db.now() },
      lesson: { video: null, steps: [{ id: 'observe', title: 'Synthetic step' }] } } };
    await importContent(db, { items: [item] });
    const lesson = await api(messagesPath, 'POST', { question: '课程上下文', context: { kind: 'lesson', lesson_id: lessonId, lesson_version: 1 } }, undefined, 202);
    assert.equal(lesson.evidence.lesson.content_version, 1);
    await importContent(db, { items: [{ ...item, expected_revision: 1, status: 'withdrawn' }] });
    const exportAfterWithdrawal = await api('/auth/data-export/assistant_messages');
    const exported = exportAfterWithdrawal.items.find((row: any) => row.id === lesson.id);
    assert.deepEqual(exported.evidence, {}); assert.equal(exported.result, null);
    assert.equal((await api(`/assistant-messages/${lesson.id}`)).error_code, 'CONTENT_UNAVAILABLE');
    await api(messagesPath, 'POST', { question: '课程', context: { kind: 'lesson', lesson_id: lessonId, lesson_version: 1 } }, undefined, 404);
    const page = await api(`${messagesPath}?limit=1`); assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
    const otherConversation = await api(`/pets/${otherPet.id}/assistant-conversations`, 'POST', {});
    await api(`/assistant-conversations/${otherConversation.id}/messages?cursor=${encodeURIComponent(page.next_cursor)}`, 'GET', undefined, undefined, 400);
    const viewerConversation = await api(conversationPath, 'POST', {}, undefined, 201, viewer.access_token);
    const viewerMessage = await api(`/assistant-conversations/${viewerConversation.id}/messages`, 'POST', { question: '本人的问题' }, undefined, 202, viewer.access_token);
    await api(`/assistant-messages/${viewerMessage.id}`, 'GET', undefined, undefined, 404);
    now += 1000;
    await api(`/households/${owner.household.id}/members/${viewer.user.id}`, 'DELETE');
    await worker.work();
    await api(`/assistant-messages/${viewerMessage.id}`, 'GET', undefined, undefined, 404, viewer.access_token);
    const personalExport = await api('/auth/data-export/assistant_messages', 'GET', undefined, undefined, 200, viewer.access_token);
    assert.equal(personalExport.items.length, 0);
    assert.equal((await db.get('SELECT status FROM assistant_messages WHERE id=?', viewerMessage.id))!.status, 'failed');
    assert.equal(external, 0);
  } finally { globalThis.fetch = originalFetch; process.env.DATA_MODE = mode; await app.close(); await backend.close(); }
});
