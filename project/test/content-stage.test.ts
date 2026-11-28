import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';
import { ContentService, importContent } from '../src/content';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
function entry(db: Db, overrides: Row = {}): Row {
  return { id: db.id(), kind: 'lesson', content_version: 1, expected_revision: 0, status: 'published', content: {
    title: 'Synthetic lesson title', category: 'test-only', summary: 'Synthetic isolated test fixture', body: 'No real care or training advice.',
    applicability: 'Automated isolated tests only', sources: [{ title: 'Synthetic source', reference: 'test fixture, not a reviewed publication' }],
    review: { status: 'reviewed', reviewer: 'Synthetic test reviewer, no actual content approval', reviewed_at: db.now() },
    lesson: { video: null, steps: [{ id: 'first', title: 'Synthetic step one' }, { id: 'second', title: 'Synthetic step two' }] },
  }, ...overrides };
}

test('内容默认空目录；仅受控导入的已审核发布项可查，同版本正文不可变，发布状态有并发版本', async () => {
  const db = new Db(':memory:', () => new Date('2026-11-24T04:00:00Z'));
  try {
    const content = new ContentService(db);
    assert.deepEqual((await content.list('test-reader', {})).items, []);
    const first = entry(db), draft = entry(db, { status: 'draft' });
    await importContent(db, { items: [first, draft] });
    assert.equal((await content.list('test-reader', {})).items.length, 1);
    await assert.rejects(content.detail('test-reader', draft.id, {}), status(404));
    assert.equal((await content.detail('test-reader', first.id, {})).review.reviewer, first.content.review.reviewer);
    assert.equal((await importContent(db, { items: [{ ...first, expected_revision: 1 }] })).items[0].revision, 1);
    await assert.rejects(importContent(db, { items: [{ ...first, expected_revision: 1, content: { ...first.content, body: 'changed same version' } }] }), status(409));
    await assert.rejects(importContent(db, { items: [{ ...first, status: 'withdrawn' }] }), status(409));
    const withdrawn = { ...first, expected_revision: 1, status: 'withdrawn' };
    assert.equal((await importContent(db, { items: [withdrawn] })).items[0].revision, 2);
    await assert.rejects(content.detail('test-reader', first.id, {}), status(404));
    await assert.rejects(importContent(db, { items: [{ ...entry(db), content: { ...first.content, sources: [] } }] }), ZodError);
    await assert.rejects(importContent(db, { items: [{ ...entry(db), content: { ...first.content, review: { status: 'pending' } } }] }), ZodError);
    await assert.rejects(importContent(db, { items: [{ ...entry(db), content: { ...first.content, review: { status: 'reviewed', reviewer: 'Synthetic', reviewed_at: '2026-11-25T00:00:00Z' } } }] }), status(400));
    const newId = db.id();
    await assert.rejects(importContent(db, { items: [entry(db, { id: newId }), { ...withdrawn, expected_revision: 1 }] }), status(409));
    assert.equal(await db.get('SELECT id FROM content_items WHERE id=?', newId), undefined, 'whole file import must roll back on conflict');
  } finally { await db.close(); }
});

test('课程学习属于本人和内容版本，步骤与learned独立，重复保存不重复计数，新版本不继承完成', async () => {
  let now = new Date('2026-11-24T04:00:00Z');
  const db = new Db(':memory:', () => now);
  try {
    const identity = new IdentityService(db), content = new ContentService(db);
    const one = await identity.register({ email: 'learning-one@example.invalid', password: 'password123' });
    const two = await identity.register({ email: 'learning-two@example.invalid', password: 'password123' });
    const first = entry(db), second = entry(db), draft = entry(db, { status: 'draft' });
    await importContent(db, { items: [first, second, draft] });
    assert.deepEqual((await content.learning(one.user.id, {})).counts, { scope: 'all_current_published_lessons', available_count: 2, learned_count: 0 });
    const input = { content_version: 1, completed_step_ids: ['first'], learned: true, expected_version: 0 };
    const saved = await content.putProgress(one.user.id, first.id, input, 'learn-once');
    assert.equal(saved.learned, true); assert.deepEqual(saved.completed_step_ids, ['first']);
    assert.deepEqual(await content.putProgress(one.user.id, first.id, input, 'learn-once'), saved);
    await assert.rejects(content.putProgress(one.user.id, first.id, { ...input, learned: false }, 'learn-once'), status(409));
    await assert.rejects(content.putProgress(one.user.id, first.id, input), status(409));
    await assert.rejects(content.putProgress(one.user.id, first.id, { ...input, expected_version: 1, completed_step_ids: ['not-a-step'] }), status(400));
    await assert.rejects(content.putProgress(one.user.id, draft.id, input), status(404));
    assert.equal((await content.learning(one.user.id, {})).counts.learned_count, 1);
    assert.equal((await content.learning(two.user.id, {})).items.length, 0);
    assert.equal((await content.detail(two.user.id, first.id, {})).progress.version, 0);
    const allSteps = await content.putProgress(two.user.id, first.id, { ...input, completed_step_ids: ['first', 'second'], learned: false });
    assert.equal(allSteps.learned, false); assert.equal((await content.learning(two.user.id, {})).counts.learned_count, 0);
    now = new Date('2026-11-24T05:00:00Z');
    const v2 = { ...first, content_version: 2, expected_revision: 1, content: { ...first.content, title: 'Synthetic lesson second version' } };
    await importContent(db, { items: [v2] });
    const progress = await content.learning(one.user.id, {});
    assert.equal(progress.items[0].content_status, 'updated'); assert.equal(progress.items[0].content_version, 1); assert.equal(progress.counts.learned_count, 0);
    assert.equal((await content.detail(one.user.id, first.id, { version: 1 })).content_version, 1);
    await assert.rejects(content.putProgress(one.user.id, first.id, input, 'learn-once'), status(409));
    await content.putProgress(one.user.id, first.id, { ...input, content_version: 2 });
    const paged = await content.learning(one.user.id, { limit: 1 });
    assert.ok(paged.next_cursor); assert.equal((await content.learning(one.user.id, { limit: 1, cursor: paged.next_cursor })).items[0].content_version, 2);
    await assert.rejects(content.learning(two.user.id, { cursor: paged.next_cursor }), status(400));
    await importContent(db, { items: [{ ...v2, expected_revision: 2, status: 'withdrawn' }] });
    const hidden = await content.learning(one.user.id, {});
    assert.equal(hidden.counts.available_count, 1); assert.equal(hidden.counts.learned_count, 0); assert.ok(hidden.items.every((row: Row) => row.title === null && row.content_status === 'unavailable'));
    await assert.rejects(content.putProgress(one.user.id, first.id, { ...input, content_version: 2 }, 'new-key'), status(404));
  } finally { await db.close(); }
});

test('目录按标题、分类和种类检索，游标绑定过滤与本人，通配符按字面匹配', async () => {
  const db = new Db(':memory:');
  try {
    const content = new ContentService(db), one = entry(db), two = entry(db);
    two.content.title = '100%_Only';
    await importContent(db, { items: [one, two] });
    assert.equal((await content.list('one', { q: 'synthetic', category: 'test-only', kind: 'lesson' })).items.length, 1);
    assert.equal((await content.list('one', { q: '%_' })).items[0].id, two.id);
    const page = await content.list('one', { limit: 1 }); assert.ok(page.next_cursor);
    assert.equal((await content.list('one', { limit: 1, cursor: page.next_cursor })).items.length, 1);
    await assert.rejects(content.list('two', { cursor: page.next_cursor }), status(400));
    await assert.rejects(content.list('one', { cursor: page.next_cursor, category: 'changed' }), status(400));
  } finally { await db.close(); }
});

test('新版本发布不能开放从未发布的旧审核稿，也不能复活已撤回的旧正文', async () => {
  const db = new Db(':memory:');
  try {
    const content = new ContentService(db), reviewedDraft = entry(db, { status: 'draft' }), previouslyPublished = entry(db);
    await importContent(db, { items: [reviewedDraft, previouslyPublished] });
    await importContent(db, { items: [{ ...previouslyPublished, expected_revision: 1, status: 'withdrawn' }] });
    await importContent(db, { items: [
      { ...reviewedDraft, content_version: 2, expected_revision: 1, status: 'published', content: { ...reviewedDraft.content, title: 'Actual published test v2' } },
      { ...previouslyPublished, content_version: 2, expected_revision: 2, content: { ...previouslyPublished.content, title: 'New test publication after withdrawal' } },
    ] });
    for (const item of [reviewedDraft, previouslyPublished]) {
      await assert.rejects(content.detail('test-reader', item.id, { version: 1 }), status(404));
      assert.equal((await content.detail('test-reader', item.id, { version: 2 })).content_version, 2);
    }
    await importContent(db, { items: [{ ...reviewedDraft, content_version: 2, expected_revision: 2, status: 'draft', content: { ...reviewedDraft.content, title: 'Actual published test v2' } }] });
    await importContent(db, { items: [{ ...reviewedDraft, content_version: 3, expected_revision: 3, status: 'published', content: { ...reviewedDraft.content, title: 'Published test v3' } }] });
    await assert.rejects(content.detail('test-reader', reviewedDraft.id, { version: 2 }), status(404));
  } finally { await db.close(); }
});
