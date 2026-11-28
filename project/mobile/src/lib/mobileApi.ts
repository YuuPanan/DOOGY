import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { ApiClient } from './client';
import * as Crypto from 'expo-crypto';
import { accountExport } from './accountExport';
import { cleanExpiredShares, clearShares, shareCachedFile } from './shareCache';

async function save(bytes: Uint8Array, name: string, mimeType: string, check: () => void) {
  check();
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90) || 'doogy-export';
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
    const link = document.createElement('a'); link.href = url; link.download = safeName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
  }
  await shareCachedFile(bytes, safeName, mimeType, check);
}
export class MobileApi extends ApiClient {
  constructor(...args: ConstructorParameters<typeof ApiClient>) {
    super(...args);
    // Cache/storage failures must not block first launch or identity recovery; export/clear still report errors.
    if (Platform.OS !== 'web') try { cleanExpiredShares(); } catch {}
  }
  override async clear() {
    const session = super.clear();
    const results = await Promise.allSettled([session, Platform.OS !== 'web' ? clearShares() : Promise.resolve()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  override async upload(...args: Parameters<ApiClient['upload']>) {
    if (Platform.OS === 'web') return super.upload(...args);
    const [path, file, key, options = {}] = args, nativeFile = new File(file.uri), body = new FormData();
    // Expo's fetch accepts FileBlob bytes, not RN's proprietary URI multipart part.
    body.append('file', { name: file.name, type: file.mimeType ?? 'application/octet-stream', bytes: () => nativeFile.bytes() } as any);
    for (const [name, value] of Object.entries(options.fields ?? {})) body.append(name, value);
    return this.request(path, { method: options.method ?? 'POST', body, key, fingerprint: `${file.uri}|${file.name}|${JSON.stringify(options.fields ?? {})}` });
  }
  async download(path: string, filename: string) {
    const epoch = this.sessionEpoch;
    const response = await this.request<Response>(path, { responseType: 'response' });
    const bytes = new Uint8Array(await response.arrayBuffer()); this.requireEpoch(epoch);
    await save(bytes, filename, response.headers.get('content-type') ?? 'application/octet-stream', () => this.requireEpoch(epoch));
  }
  async exportAccount() {
    const epoch = this.sessionEpoch, manifest = await this.get('/auth/data-export');
    const result = await accountExport(this, manifest, content => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, content), () => this.requireEpoch(epoch));
    this.requireEpoch(epoch); await save(new TextEncoder().encode(result.content), 'doogy-account.ndjson', 'application/x-ndjson', () => this.requireEpoch(epoch));
    return { counts: result.counts, total_records: result.total_records };
  }
}
