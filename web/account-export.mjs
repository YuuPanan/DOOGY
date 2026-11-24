const ndjson = (value) => JSON.stringify(value) + '\n';

export async function buildAccountExport(api, manifest, { onProgress, signal } = {}) {
  signal?.throwIfAborted();
  if (!globalThis.crypto?.subtle) throw new Error('请通过本机地址或 HTTPS 打开体验台，以生成文件校验值。');
  const scopes = [
    { household_id: null, sections: manifest.personal_sections },
    ...manifest.households.map((household) => ({ household_id: household.id, sections: household.sections }))
  ];
  const total = scopes.reduce((sum, scope) => sum + scope.sections.length, 0);
  const parts = [ndjson({ type: 'manifest', ...manifest })], counts = [];
  let rows = 0;
  onProgress?.({ completed: 0, total, rows });

  for (const { household_id, sections } of scopes) for (const section of sections) {
    const query = new URLSearchParams({ snapshot_at: manifest.generated_at, limit: '200' });
    if (household_id !== null) query.set('household_id', household_id);
    let cursor = null, records = 0;
    do {
      signal?.throwIfAborted();
      if (cursor) query.set('cursor', cursor);
      const page = await api.get(`/auth/data-export/${encodeURIComponent(section)}?${query}`, { signal });
      signal?.throwIfAborted();
      const next = page?.next_cursor;
      const validCursor = next === null || (typeof next === 'string' && next.length > 0 && next !== cursor);
      if (page?.section !== section || page.household_id !== household_id || page.generated_at !== manifest.generated_at
          || !Array.isArray(page.items) || !validCursor) {
        throw new Error('导出分区返回的分页不完整，请重新预览后再试。');
      }
      for (const data of page.items) parts.push(ndjson({ type: 'record', section, household_id, data }));
      rows += page.items.length;
      records += page.items.length;
      cursor = next;
    } while (cursor !== null);
    counts.push({ section, household_id, records });
    onProgress?.({ completed: counts.length, total, rows });
  }

  signal?.throwIfAborted();
  // shortcut: the browser buffers the export for hashing, use the streaming CLI for large exports.
  const content = new Blob(parts);
  parts.length = 0;
  const digest = await crypto.subtle.digest('SHA-256', await content.arrayBuffer());
  signal?.throwIfAborted();
  const content_sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const complete = ndjson({ type: 'complete', rows, counts, content_sha256, completed_at: new Date().toISOString() });
  const filename = `account-${manifest.generated_at.replace(/[:.]/g, '-')}.ndjson`;
  return { blob: new Blob([content, complete], { type: 'application/x-ndjson' }), filename, rows, sections: counts.length };
}
