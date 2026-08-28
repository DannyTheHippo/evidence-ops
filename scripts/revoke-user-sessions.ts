import { config } from 'dotenv';
config();

import { MongoClient } from 'mongodb';
import { revokeUserSessions } from './lib/revoke-user-sessions';

/**
 * Operator entry point for the session-epoch revocation lever (`User.tokenVersion`,
 * `jwt-auth.guard.ts`): raising a user's epoch refuses every live session and personal access
 * token they hold, immediately, with no other attribute of the account touched.
 *
 *   npx tsx scripts/revoke-user-sessions.ts --user <email>
 *
 * Argument parsing, connection handling and reporting live here; the raise itself is
 * `lib/revoke-user-sessions.ts`, which documents the write it makes.
 */

const MONGO_DB_URI =
  process.env.MONGO_DB_URI ?? 'mongodb://localhost:27018/evidence-ops?directConnection=true';

function parseArgs(argv: string[]): { email: string } {
  let email: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--user') {
      email = argv[i + 1];
      i += 1;
    }
  }
  if (!email) {
    console.error('usage: revoke-user-sessions.ts --user <email>');
    process.exit(1);
  }
  // `email` is stored lowercased/trimmed (user.schema.ts) — matching that here means a
  // differently-cased invocation still finds the row instead of reporting a false "not found".
  return { email: email.toLowerCase().trim() };
}

async function main(): Promise<void> {
  const { email } = parseArgs(process.argv.slice(2));
  const client = await MongoClient.connect(MONGO_DB_URI);
  try {
    const result = await revokeUserSessions(client.db(), email);

    if (result.outcome === 'user-not-found') {
      console.error(`refusing: no user found with email '${email}'`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `revoked sessions for '${email}': tokenVersion ${result.previousTokenVersion} -> ${result.newTokenVersion}`,
    );
    // Both `JwtAuthGuard` and `ApiKeysService.verify` compare this row's `tokenVersion` against the
    // epoch minted into each credential, so every live browser session and personal access token
    // this user holds now fails that comparison on its next use.
    console.log(
      'every live session and personal access token for this user is now refused — they must sign in again',
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `✗ ${error.message}` : error);
  process.exitCode = 1;
});
