import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { importContent } from '../src/content';
import { IdentityService } from '../src/identity';
import { openBackendFixture } from './backend-fixture';

test('structured published plan can be read, explicitly saved as a goal snapshot and re-read without changing targets', async () => {
  const fixture = await openBackendFixture(), db = fixture.db, app = await createApp({ db, quiet: true });
  try {
    const identity = new IdentityService(db), owner = await identity.register({ email: 'plan-owner@example.invalid', password: 'Plan-interface-only-2026' });
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Synthetic plan pet' });
    const id = db.id(), exercise = { walk_minutes: 10, play_minutes: 5, training_minutes: 5 };
    const entry = { id, kind: 'plan', content_version: 1, expected_revision: 0, status: 'published', content: {
      title: 'Synthetic interface plan', category: 'interface_test', summary: '', body: 'Synthetic interface test only, not care guidance.',
      applicability: 'Test database only', sources: [{ title: 'Synthetic fixture', reference: 'fixture:content-plan' }],
      review: { status: 'reviewed', reviewer: 'Synthetic interface validation', reviewed_at: db.now() }, exercise_plan: exercise,
    } };
    for (const invalid of [{ ...exercise, walk_minutes: -1 }, { ...exercise, walk_minutes: 1440 }, { ...exercise, extra: 1 }]) {
      await assert.rejects(importContent(db, { items: [{ ...entry, content: { ...entry.content, exercise_plan: invalid } }] }));
    }
    await assert.rejects(importContent(db, { items: [{ ...entry, kind: 'tip' }] }));
    await importContent(db, { items: [entry] });
    await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/api/v1`;
    async function api(endpoint: string, method = 'GET', body?: unknown) {
      const response = await fetch(base + endpoint, { method, headers: { authorization: `Bearer ${owner.access_token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json() as any; assert.ok(response.ok, JSON.stringify(result)); return result;
    }
    const detail = await api(`/content/${id}`); assert.deepEqual(detail.exercise_plan, exercise);
    const date = db.now().slice(0, 10), target = { active_minutes: 45, steps: 6000, intake_kcal: null };
    await api(`/pets/${pet.id}/goals`, 'PUT', { effective_date: date, expected_version: 0, targets: target });
    await api(`/pets/${pet.id}/goals`, 'PUT', { effective_date: date, expected_version: 1, targets: target, source: 'user_provided',
      plan: { name: detail.title, content_version: `${detail.id}@${detail.content_version}`, ...detail.exercise_plan } });
    const saved = await api(`/pets/${pet.id}/goals?date=${date}&timezone=UTC`);
    assert.deepEqual(saved.goals.targets, target); assert.equal(saved.goals.plan.walk_minutes, 10);
    assert.equal(saved.goals.plan.content_version, `${id}@1`); assert.equal(saved.goals.version, 2);
  } finally { await app.close(); await fixture.close(); }
});
