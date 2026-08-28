import { config } from 'dotenv';
config();

import { MongoClient } from 'mongodb';
import { coTenantUser } from './lib/co-tenant-user';
import { UserRole } from '../src/shared/enums/user-role.enum';

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

const USER_ROLES: readonly string[] = Object.values(UserRole);

function parseArgs(argv: string[]): { email: string; tenantId: string; role?: string } {
  let email: string | undefined;
  let tenantId: string | undefined;
  let role: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--user') {
      email = argv[i + 1];
      i += 1;
    } else if (arg === '--tenant') {
      tenantId = argv[i + 1];
      i += 1;
    } else if (arg === '--role') {
      role = argv[i + 1];
      i += 1;
    }
  }
  if (!email || !tenantId) {
    console.error(
      `usage: co-tenant-user.ts --user <email> --tenant <tenantId> [--role ${USER_ROLES.join('|')}]`,
    );
    process.exit(1);
  }
  // Refuses an unrecognised role rather than passing it through: the schema's `enum` would reject
  // it anyway, but this is a driver-level write that bypasses the schema, so a typo would persist a
  // role no guard recognises and the account would hold no privileges it could name.
  if (role !== undefined && !USER_ROLES.includes(role)) {
    console.error(`refusing: --role must be one of ${USER_ROLES.join(', ')} (got '${role}')`);
    process.exit(1);
  }
  // `email` is stored lowercased/trimmed (user.schema.ts) — matching that here means a
  // differently-cased invocation still finds the row instead of reporting a false "not found".
  return { email: email.toLowerCase().trim(), tenantId, role };
}

async function main(): Promise<void> {
  const { email, tenantId, role } = parseArgs(process.argv.slice(2));
  const client = await MongoClient.connect(MONGO_DB_URI);
  try {
    const result = await coTenantUser(client.db(), email, tenantId, role);

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
    console.log(
      role === undefined
        ? `role unchanged: '${result.role}' (pass --role to set it)`
        : `role set to '${result.role}'`,
    );
    // Both writes diverge this row from any token already issued against it, and `JwtAuthGuard`
    // compares `tenantId` and `role` against the row on every request — so the user's existing
    // sessions and personal access tokens are refused until they sign in again.
    console.log('the user must sign in again — existing sessions and tokens no longer verify');
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `✗ ${error.message}` : error);
  process.exitCode = 1;
});
