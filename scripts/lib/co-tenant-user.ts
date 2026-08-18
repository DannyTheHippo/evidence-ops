import type { Db } from 'mongodb';

/**
 * Outcome of one co-tenanting attempt. Every refusal is its own variant rather than a thrown
 * error: the caller decides how to report it, and a refusal changes nothing in the database.
 */
export type CoTenantUserResult =
  | { outcome: 'tenant-not-found' }
  | { outcome: 'user-not-found' }
  | { outcome: 'already-member' }
  | {
      outcome: 'moved';
      previousTenantId: string;
      tenantName: string;
      apiKeysMoved: number;
    };

/**
 * Moves an existing user into an existing tenant, carrying that user's personal access tokens
 * with them. Driver-level: no Mongoose model, schema default, or plugin (including
 * `tenantScopePlugin`) participates, so the writes are exactly the two stated below.
 *
 * Refuses rather than guesses — the target tenant must already exist in the `tenants` registry and
 * the user must already exist, or nothing is changed. A user already in the target tenant is
 * reported as `already-member` and left untouched.
 *
 * The `api_keys` rows move before the `users` row. A key row carries the tenant it was minted
 * under, and `ApiKeysService.list`/`revoke` match that value against the caller's session tenant,
 * so a key left behind in the vacated tenant is invisible and unrevokable to its own owner. The
 * ordering makes an interrupted run repairable: with the user still in the previous tenant, a
 * re-run repeats both writes, whereas moving the user first would leave the re-run reporting
 * `already-member` and never reaching the keys. Revoked and expired keys move too — both still
 * appear in the owner's listing.
 */
export const coTenantUser = async (
  db: Db,
  email: string,
  tenantId: string,
): Promise<CoTenantUserResult> => {
  const tenant = await db.collection('tenants').findOne({ tenantId });
  if (!tenant) {
    return { outcome: 'tenant-not-found' };
  }

  const user = await db.collection('users').findOne({ email });
  if (!user) {
    return { outcome: 'user-not-found' };
  }

  const previousTenantId = user.tenantId as string;
  if (previousTenantId === tenantId) {
    return { outcome: 'already-member' };
  }

  const apiKeys = await db
    .collection('api_keys')
    .updateMany({ userId: user._id }, { $set: { tenantId }, $currentDate: { updatedAt: true } });

  await db
    .collection('users')
    .updateOne({ _id: user._id }, { $set: { tenantId }, $currentDate: { updatedAt: true } });

  return {
    outcome: 'moved',
    previousTenantId,
    tenantName: tenant.name as string,
    apiKeysMoved: apiKeys.modifiedCount,
  };
};
