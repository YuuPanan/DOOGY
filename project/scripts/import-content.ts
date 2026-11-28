import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Db } from '../src/db';
import { importContent } from '../src/content';

async function main() {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length) throw new Error('Usage: import-content <catalog.json>');
  const input = JSON.parse(await readFile(resolve(filename), 'utf8'));
  const db = await Db.open();
  try { console.log(JSON.stringify(await importContent(db, input), null, 2)); }
  finally { await db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
