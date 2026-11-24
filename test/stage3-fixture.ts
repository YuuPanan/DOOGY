import { createHash } from 'node:crypto';
import { Db } from '../src/db';

export const stage3Tables = ['pet_media','behavior_records','interpretations','assistant_conversations','assistant_messages'];

// Direct synthetic persistence fixture; this does not exercise upload or codec validation.
export async function seedStage3Data(db: Db, user: string, pet: string) {
  const media = db.id(), behavior = db.id(), interpretation = db.id(), conversation = db.id(), message = db.id(), now = db.now();
  const bytes = Buffer.from('synthetic-media-lifecycle-bytes'), captured = new Date(Date.parse(now) - 60000).toISOString();
  await db.run(`INSERT INTO pet_media(id,pet_id,filename,content_type,size_bytes,sha256,content_base64,duration_seconds,captured_at,source,created_by,created_at,validation_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, media, pet, 'synthetic-lifecycle.wav', 'audio/wav', bytes.length,
    createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), 10, captured, 'synthetic', user, now, JSON.stringify({ source: 'direct-test-fixture', codec_validated: false }));
  await db.run(`INSERT INTO behavior_records(id,pet_id,media_id,media_deleted_at,labels_json,start_at,end_at,notes,source,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, behavior, pet, media, null, '["barking"]', captured, now, 'Manual behavior notes', 'owner_annotation', user, now);
  await db.run(`INSERT INTO interpretations(id,pet_id,media_id,behavior_record_id,from_at,to_at,background_json,notes,status,captured_mode,attempt,result_json,evidence_json,
    execution_source,model_version,error_code,created_by,created_at,updated_at,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    interpretation, pet, media, behavior, captured, now, '{"routine":"changed"}', 'Manual interpretation notes', 'succeeded', 'offline', 1,
    '{"text":"DERIVED_MEDIA_SECRET"}', JSON.stringify({ media_id: media, activity: { source_revision: 1 }, text: 'DERIVED_MEDIA_SECRET' }), 'simulated', 'synthetic-v1', null, user, now, now, now, now);
  await db.run('INSERT INTO assistant_conversations(id,user_id,pet_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)', conversation, user, pet, 'Private synthetic question', now, now);
  await db.run(`INSERT INTO assistant_messages(id,conversation_id,question,context_json,evidence_json,media_id,behavior_record_id,interpretation_id,lesson_id,lesson_version,
    status,captured_mode,attempt,result_json,execution_source,model_version,error_code,created_at,updated_at,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    message, conversation, 'Keep my original question', JSON.stringify({ media_id: media, private_snapshot: 'DERIVED_MEDIA_SECRET' }),
    JSON.stringify({ interpretation_id: interpretation, private_snapshot: 'DERIVED_MEDIA_SECRET' }), null, behavior, interpretation, null, null,
    'succeeded', 'offline', 1, '{"text":"DERIVED_MEDIA_SECRET"}', 'simulated', 'synthetic-v1', null, now, now, now, now);
  return { media, behavior, interpretation, conversation, message, bytes };
}
