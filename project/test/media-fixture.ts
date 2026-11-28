import { createHash } from 'node:crypto';
import { Db, Row } from '../src/db';

export function syntheticWav(seconds = 1) {
  const dataSize = 8000 * 2 * seconds, bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF'); bytes.writeUInt32LE(36 + dataSize, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}

export async function insertSyntheticMedia(db: Db, pet: string, user: string | null, options: Row = {}) {
  const bytes = options.bytes ?? syntheticWav(), duration = options.duration_seconds ?? 1;
  const row = { id: options.id ?? db.id(), pet_id: pet, filename: options.filename ?? 'synthetic-test.wav', content_type: options.content_type ?? 'audio/wav',
    size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64'), duration_seconds: duration,
    captured_at: options.captured_at ?? new Date(db.clock().getTime() - duration * 1000).toISOString(), source: 'synthetic', created_by: user,
    created_at: options.created_at ?? db.now(), validation_json: JSON.stringify({ method: 'synthetic_test_fixture', ...options.validation }) };
  await db.run(`INSERT INTO pet_media(id,pet_id,filename,content_type,size_bytes,sha256,content_base64,duration_seconds,captured_at,source,created_by,created_at,validation_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.pet_id, row.filename, row.content_type, row.size_bytes, row.sha256, row.content_base64,
    row.duration_seconds, row.captured_at, row.source, row.created_by, row.created_at, row.validation_json);
  return { ...row, bytes };
}
