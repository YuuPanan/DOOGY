import { Db } from '../src/db';
import { ContentService, importContent } from '../src/content';

export const contentHealthTables = ['content_items','content_versions','learning_progress','health_observation_reads'];

export async function seedContentHealthData(db: Db, user: string, pet: string) {
  const content = db.id(), observation = db.id(), now = db.now(), date = now.slice(0, 10);
  for (const version of [1, 2]) {
    await importContent(db, { items: [{ id: content, kind: 'lesson', content_version: version, expected_revision: version - 1, status: 'published',
      content: { title: `Synthetic lesson ${version}`, category: 'care', body: 'Synthetic lifecycle fixture content', applicability: 'Synthetic tests only',
        sources: [{ title: 'Synthetic fixture', reference: 'synthetic-lifecycle-fixture' }], review: { status: 'reviewed', reviewer: 'Synthetic reviewer', reviewed_at: now },
        lesson: { video: null, steps: [{ id: 'step-one', title: 'Observe and record' }] } } }] });
    await new ContentService(db).putProgress(user, content, { content_version: version, completed_step_ids: version === 1 ? ['step-one'] : [], learned: version === 1, expected_version: 0 });
  }
  await db.run('INSERT INTO activity_observations VALUES (?,?,?,?,?,?,?,?)', observation, pet, date, 'UTC', 'synthetic-lifecycle-v1', observation,
    now, JSON.stringify({ id: observation, pet_id: pet, source: 'synthetic-lifecycle-fixture', observations: [] }));
  await db.run('INSERT INTO health_observation_reads VALUES (?,?,?)', user, observation, now);
  return { content, observation };
}
