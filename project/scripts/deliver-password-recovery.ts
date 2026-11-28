import { Db } from '../src/db';
import { PasswordRecoveryService } from '../src/password-recovery';

async function main() {
  const [requestId, ...extra] = process.argv.slice(2);
  if (!requestId || extra.length) throw new Error('Usage: deliver-password-recovery <request-id>');
  const db = await Db.open();
  try { console.log(JSON.stringify(await new PasswordRecoveryService(db).deliver(requestId))); }
  finally { await db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
