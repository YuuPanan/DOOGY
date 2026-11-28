import { Db } from './db';

const references = (value: unknown, ids: Set<string>): boolean => typeof value === 'string' ? ids.has(value)
  : Array.isArray(value) ? value.some(item => references(item, ids))
    : value !== null && typeof value === 'object' && Object.entries(value).some(([key, item]) => ids.has(key) || references(item, ids));

export async function purgeSourceCopies(db: Db, ids: Set<string>, dryRun = false) {
  if (!ids.size) return { idempotency_keys: 0, audit_logs: 0 };
  const cached = (await db.all('SELECT user_id,scope,key,request_json,response_json FROM idempotency_keys'))
    .filter(row => references(JSON.parse(row.request_json), ids) || references(JSON.parse(row.response_json), ids));
  const audits = (await db.all('SELECT id,resource_id,metadata_json FROM audit_logs'))
    .filter(row => ids.has(row.resource_id) || references(JSON.parse(row.metadata_json), ids));
  if (!dryRun) {
    for (const row of cached) await db.run('DELETE FROM idempotency_keys WHERE user_id=? AND scope=? AND key=?', row.user_id, row.scope, row.key);
    for (const row of audits) await db.run('DELETE FROM audit_logs WHERE id=?', row.id);
  }
  return { idempotency_keys: cached.length, audit_logs: audits.length };
}

async function clearInterpretationFeedback(db: Db, ids: Set<string>, dryRun = false) {
  if (!ids.size) return [];
  // shortcut: scan JSON references at trial volume; add indexed source columns if feedback grows.
  const feedback = (await db.all("SELECT id,evidence_json FROM behavior_feedback WHERE evidence_json<>'{}'"))
    .filter(row => { const evidence = JSON.parse(row.evidence_json); return evidence?.source === 'interpretation' && (ids.has(evidence.interpretation_id) || ids.has(evidence.media_id)); });
  if (!dryRun) for (const row of feedback) await db.run("UPDATE behavior_feedback SET evidence_json='{}' WHERE id=?", row.id);
  return feedback.map(row => row.id as string);
}

export async function deletePetMedia(db: Db, id: string, record = true) {
  return db.transaction(async () => {
    const media = await db.get('SELECT id FROM pet_media WHERE id=?', id), now = db.now();
    const behaviorScope = 'SELECT id FROM behavior_records WHERE media_id=?';
    const interpretationScope = `SELECT id FROM interpretations WHERE media_id=? OR behavior_record_id IN (${behaviorScope})`;
    const messageWhere = `media_id=? OR behavior_record_id IN (${behaviorScope}) OR interpretation_id IN (${interpretationScope})`;
    const behaviors = await db.all(behaviorScope, id);
    const interpretations = await db.all(interpretationScope, id, id);
    const messages = await db.all(`SELECT id FROM assistant_messages WHERE ${messageWhere}`, id, id, id, id);
    const ids = new Set<string>([id, ...behaviors.map(row => row.id), ...interpretations.map(row => row.id), ...messages.map(row => row.id)]);
    const feedback = await clearInterpretationFeedback(db, ids);
    for (const feedbackId of feedback) ids.add(feedbackId);
    // Clear dependent snapshots before SET NULL removes the paths used to find them.
    await db.run(`UPDATE assistant_messages SET context_json='{}',evidence_json='{}',result_json=NULL,status='failed',error_code='MEDIA_SOURCE_DELETED',
      media_id=NULL,execution_source=NULL,model_version=NULL,updated_at=?,completed_at=? WHERE ${messageWhere}`, now, now, id, id, id, id);
    await db.run(`UPDATE interpretations SET evidence_json='{}',result_json=NULL,status='failed',error_code='MEDIA_SOURCE_DELETED',
      media_id=NULL,execution_source=NULL,model_version=NULL,updated_at=?,completed_at=? WHERE id IN (${interpretationScope})`, now, now, id, id);
    await db.run('UPDATE behavior_records SET media_id=NULL,media_deleted_at=? WHERE media_id=?', now, id);
    const copies = await purgeSourceCopies(db, ids);
    await db.run('DELETE FROM pet_media WHERE id=?', id);
    if (media && record) await db.recordDeletion('pet_media', id);
    return { deleted: Boolean(media), media_id: id, affected: { behavior_records: behaviors.length, interpretations: interpretations.length,
      assistant_messages: messages.length, feedback_evidence: feedback.length, ...copies } };
  });
}

export async function invalidatePetDerived(db: Db, petId: string, reason: string, dryRun = false, sourceRecordId?: string) {
  return db.transaction(async () => {
    const activity = reason === 'ACTIVITY_SOURCE_EXPIRED', care = ['CARE_SOURCE_WITHDRAWN', 'CARE_SOURCE_CHANGED'].includes(reason) && sourceRecordId !== undefined;
    const interpretations = activity ? (await db.all('SELECT id,status,evidence_json FROM interpretations WHERE pet_id=?', petId))
      .filter(row => ['pending','processing'].includes(row.status) || JSON.parse(row.evidence_json).activity !== undefined) : [];
    const interpretationIds = new Set(interpretations.map(row => row.id));
    const messages = activity || care ? (await db.all(`SELECT m.id,m.interpretation_id,m.evidence_json FROM assistant_messages m
      JOIN assistant_conversations c ON c.id=m.conversation_id WHERE c.pet_id=?`, petId)).filter(row => {
      const evidence = JSON.parse(row.evidence_json);
      return activity ? evidence.kind === 'activity' || interpretationIds.has(row.interpretation_id)
        : ['nutrition','body_check_in'].includes(evidence.kind) && ((Array.isArray(evidence.source_record_ids) && evidence.source_record_ids.includes(sourceRecordId))
          || (evidence.kind === 'body_check_in' && evidence.check_in?.toileting_record_id === sourceRecordId));
    }) : [];
    const ids = new Set<string>([...interpretations.map(row => row.id), ...messages.map(row => row.id)]);
    const feedback = await clearInterpretationFeedback(db, ids, dryRun);
    for (const feedbackId of feedback) ids.add(feedbackId);
    const copies = await purgeSourceCopies(db, ids, dryRun);
    if (!dryRun) {
      const now = db.now();
      for (const row of interpretations) await db.run(`UPDATE interpretations SET result_json=NULL,evidence_json='{}',status='failed',error_code=?,execution_source=NULL,model_version=NULL,updated_at=?,completed_at=?
        WHERE id=?`, reason, now, now, row.id);
      for (const row of messages) await db.run(`UPDATE assistant_messages SET result_json=NULL,evidence_json='{}',context_json='{}',status='failed',error_code=?,execution_source=NULL,model_version=NULL,updated_at=?,completed_at=?
        WHERE id=?`, reason, now, now, row.id);
    }
    return { interpretations: interpretations.length, assistant_messages: messages.length, feedback_evidence: feedback.length, ...copies };
  });
}

export async function invalidateLessonDerived(db: Db, lessonId: string) {
  return db.transaction(async () => {
    const messages = await db.all('SELECT id FROM assistant_messages WHERE lesson_id=?', lessonId);
    const copies = await purgeSourceCopies(db, new Set<string>(messages.map(row => row.id))), now = db.now();
    await db.run(`UPDATE assistant_messages SET result_json=NULL,evidence_json='{}',context_json='{}',status='failed',error_code='CONTENT_UNAVAILABLE',
      execution_source=NULL,model_version=NULL,updated_at=?,completed_at=? WHERE lesson_id=?`, now, now, lessonId);
    return { assistant_messages: messages.length, ...copies };
  });
}
