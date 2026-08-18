import { config } from 'dotenv';
config();

import { MongoClient } from 'mongodb';
import { coTenantUser } from './lib/co-tenant-user';

/**
 * Operator entry point for putting a second user into a tenant a different registrant already
 * provisioned. Registration always creates a fresh tenant per registrant (`auth.service.ts`), so
 * this script is how a pilot gets more than one user into the same tenant.
 *
 *   npx tsx scripts/co-tenant-user.ts --user <email> --tenant <tenantId>
 *
 * Argument parsing, connection handling and reporting live here; the move itself is
 * `lib/co-tenant-user.ts`, which documents the writes it makes and the order it makes them in.
 */

const MONGO_DB_URI =
  process.env.MONGO_DB_URI ?? 'mongodb://localhost:27018/evidence-ops?directConnection=true';

function parseArgs(argv: string[]): { email: string; tenantId: string } {
  let email: string | undefined;
  let tenantId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--user') {
      email = argv[i + 1];
      i += 1;
    } else if (arg === '--tenant') {
      tenantId = argv[i + 1];
      i += 1;
    }
  }
  if (!email || !tenantId) {
    console.error('usage: co-tenant-user.ts --user <email> --tenant <tenantId>');
    process.exit(1);
  }
  // `email` is stored lowercased/trimmed (user.schema.ts) — matching that here means a
  // differently-cased invocation still finds the row instead of reporting a false "not found".
  return { email: email.toLowerCase().trim(), tenantId };
}

async function main(): Promise<void> {
  const { email, tenantId } = parseArgs(process.argv.slice(2));
  const client = await MongoClient.connect(MONGO_DB_URI);
  try {
    const result = await coTenantUser(client.db(), email, tenantId);

    if (result.outcome === 'tenant-not-found') {
      console.error(`refusing: no tenant registered with tenantId '${tenantId}'`);
      process.exitCode = 1;
      return;
    }
    if (result.outcome === 'user-not-found') {
      console.error(`refusing: no user found with email '${email}'`);
      process.exitCode = 1;
      return;
    }
    if (result.outcome === 'already-member') {
      console.log(`no-op: '${email}' is already a member of tenant '${tenantId}'`);
      return;
    }

    console.log(
      `moved '${email}' from tenant '${result.previousTenantId}' to tenant '${tenantId}' ('${result.tenantName}')`,
    );
    console.log(`moved ${result.apiKeysMoved} personal access token(s) alongside the user`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `✗ ${error.message}` : error);
  process.exitCode = 1;
});
