import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import * as Sharing from 'expo-sharing';

const TTL = 30 * 60 * 1000, MAX_FILES = 8, MAX_BYTES = 64 * 1024 * 1024;
const filename = /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-.+$/i;
const writes = new Map<string, { size: number; done: Promise<void> }>();
let clearing: Promise<void> | null = null;
const directory = () => new Directory(Paths.cache, 'doogy-shares');
function files(dir: Directory) {
  return dir.exists ? dir.list().filter((entry): entry is File => entry instanceof File && filename.test(entry.name)) : [];
}

export function cleanExpiredShares() {
  const now = Date.now();
  for (const file of files(directory())) {
    if (!writes.has(file.uri) && now - Number(filename.exec(file.name)![1]) >= TTL) file.delete();
  }
}

export function clearShares(): Promise<void> {
  if (clearing) return clearing;
  clearing = (async () => {
    // Native writes can recreate a deleted file. Wait for local IO, never for the external chooser.
    await Promise.allSettled([...writes.values()].map(write => write.done));
    for (const file of files(directory())) if (file.exists) file.delete();
  })().finally(() => { clearing = null; });
  return clearing;
}

export async function shareCachedFile(bytes: Uint8Array, safeName: string, mimeType: string, check: () => void) {
  if (clearing) await clearing;
  check(); cleanExpiredShares();
  const dir = directory(); dir.create({ idempotent: true });
  const existing = files(dir), size = existing.reduce((sum, file) => sum + (writes.get(file.uri)?.size ?? file.size), 0);
  if (bytes.byteLength > MAX_BYTES) throw new Error('文件超过本机 64 MiB 分享上限，请使用服务端导出。');
  if (existing.length >= MAX_FILES || size + bytes.byteLength > MAX_BYTES) throw new Error('临时分享缓存已满（最多 8 个文件、共 64 MiB）。未过期文件不会提前删除，请稍后重试；大型文件请使用服务端导出。');
  const created = Date.now(), file = new File(dir, `${created}-${Crypto.randomUUID()}-${safeName}`);
  let shared = false;
  try {
    file.create();
    const done = file.write(bytes); writes.set(file.uri, { size: bytes.byteLength, done });
    try { await done; } finally { writes.delete(file.uri); }
    check();
    if (Date.now() - created >= TTL) throw new Error('准备分享文件已超时，请重新导出。');
    if (!await Sharing.isAvailableAsync()) throw new Error('本机未提供文件分享能力');
    check(); await Sharing.shareAsync(file.uri, { mimeType }); shared = true;
    // Chooser completion is not a receiver-read acknowledgement. Later startup/export removes expired files.
  } finally { if (!shared && file.exists) file.delete(); }
}
