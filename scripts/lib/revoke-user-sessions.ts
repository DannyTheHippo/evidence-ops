import type { Db } from 'mongodb';

/**
 * Outcome of one revocation attempt. A refusal is its own variant rather than a thrown error, and
 * changes nothing in the database — matches `CoTenantUserResult`'s shape (`co-tenant-user.ts`), so
 * the caller decides how to report `user-not-found` rather than this function guessing at intent.
 */
export type RevokeUserSessionsResult =
  | { outcome: 'user-not-found' }
  | { outcome: 'revoked'; previousTokenVersion: number; newTokenVersion: number };

/**
 * Raises a user's session epoch by exactly one — the deliberate revocation lever `JwtAuthGuard` and
 * `ApiKeysService.verify` both compare against the `User` row on every request
 * (`user.schema.ts`). The raise is the only write this function makes: no other attribute of the
 * row changes, and no individual session or key is addressed, because none needs to be — every live
 * cookie and personal access token this user holds carries the epoch it was minted at, and stops
 * matching the row the instant this write commits.
 *
 * FAILS CLOSED: an email with no matching row is refused as `user-not-found` rather than treated as
 * a no-op success. The increment is a driver-level `$inc` against the row already located by that
 * email, never a client-supplied `tokenVersion` — this can only ever move the epoch forward by
 * exactly one per call, never set it to an arbitrary value.
 */
export const revokeUserSessions = async (
  db: Db,
  email: string,
): Promise<RevokeUserSessionsResult> => {
  const user = await db.collection('users').findOne({ email });
  if (!user) {
    return { outcome: 'user-not-found' };
  }

  const previousTokenVersion = user.tokenVersion as number;

  await db
    .collection('users')
    .updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 }, $currentDate: { updatedAt: true } });

  return {
    outcome: 'revoked',
    previousTokenVersion,
    newTokenVersion: previousTokenVersion + 1,
  };
};
