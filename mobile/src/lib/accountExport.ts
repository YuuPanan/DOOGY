type Manifest = { personal_sections: string[]; households: { id: string; sections: string[] }[]; generated_at: string; [key: string]: any };
export async function accountExport(api: { get(path: string): Promise<any> }, manifest: Manifest, digest: (content: string) => Promise<string>, check: () => void) {
  const scopes = [{ household_id: null as string | null, sections: manifest.personal_sections }, ...manifest.households.map(h => ({ household_id: h.id, sections: h.sections }))];
  const lines = [JSON.stringify({ type: 'manifest', ...manifest }) + '\n'], counts: { section: string; household_id: string | null; records: number }[] = [];
  let rows = 0;
  for (const scope of scopes) for (const section of scope.sections) {
    const params = new URLSearchParams({ snapshot_at: manifest.generated_at, limit: '200' });
    if (scope.household_id) params.set('household_id', scope.household_id);
    let cursor: string | null = null, records = 0;
    const seen = new Set<string>();
    do {
      check(); if (cursor) params.set('cursor', cursor);
      const page = await api.get(`/auth/data-export/${encodeURIComponent(section)}?${params}`); check();
      if (page.section !== section || page.household_id !== scope.household_id || page.generated_at !== manifest.generated_at || !Array.isArray(page.items)
        || !(page.next_cursor === null || typeof page.next_cursor === 'string' && page.next_cursor.length > 0 && !seen.has(page.next_cursor))) throw new Error('导出分页不完整，未生成文件，请重新预览后重试');
      for (const data of page.items) lines.push(JSON.stringify({ type: 'record', section, household_id: scope.household_id, data }) + '\n');
      records += page.items.length; rows += page.items.length; cursor = page.next_cursor;
      if (cursor) seen.add(cursor);
    } while (cursor !== null);
    counts.push({ section, household_id: scope.household_id, records });
  }
  const content = lines.join(''), content_sha256 = await digest(content); check();
  return { content: content + JSON.stringify({ type: 'complete', rows, counts, content_sha256, completed_at: new Date().toISOString() }) + '\n', counts, total_records: rows };
}
