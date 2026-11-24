import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Db } from '../src/db';

export async function dropFixtureDatabase(admin: Pool, name: string) {
  if (!/^doogy_(?:http|test|backup_test|concurrency_test)_[a-f0-9]{32}$/.test(name)) throw new Error('UNSAFE_TEST_DATABASE_NAME');
  // pg-pool.end can resolve before idle sockets close; FORCE would emit errors after the test ended.
  const deadline = Date.now() + 5000;
  while ((await admin.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [name])).rows[0].n) {
    if (Date.now() >= deadline) throw new Error('TEST_DATABASE_CONNECTIONS_DID_NOT_CLOSE');
    await new Promise(done => setTimeout(done, 20));
  }
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
}

export async function openBackendFixture(clock?: () => Date) {
  if (process.env.TEST_E2E_POSTGRES !== '1') {
    const db = new Db(':memory:', clock);
    return { db, close: () => db.close() };
  }
  const configured = process.env.TEST_DATABASE_URL;
  if (!configured) throw new Error('TEST_DATABASE_URL is required for PostgreSQL HTTP tests');
  const admin = new Pool({ connectionString: configured });
  const name = `doogy_http_${randomUUID().replace(/-/g, '')}`;
  const url = new URL(configured); url.pathname = `/${name}`;
  let db: Db | undefined, created = false;
  const close = async () => {
    try { if (db) await db.close(); }
    finally {
      try {
        if (created) {
          await dropFixtureDatabase(admin, name);
        }
      } finally { await admin.end(); }
    }
  };
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    db = await Db.open({ driver: 'postgres', url: url.toString(), clock });
    return { db, close };
  } catch (error) { await close(); throw error; }
}
