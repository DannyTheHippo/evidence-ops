import type { Db } from 'mongodb';

const COLLECTION = 'invitations';
const EXPIRES_AT_TTL_INDEX = 'invitations_expiresAt_ttl';

/**
 * `expiresAt` already exists (`invitation.schema.ts`) but was never a TTL index, so an expired or
 * already-redeemed invitation stays in the collection forever and keeps showing up in
 * `InvitationsService.list`'s admin panel. `expireAfterSeconds: 0` reads `expiresAt` as an absolute
 * deletion time rather than an offset to add to it — Mongo removes a row the moment its clock passes
 * the value already stored there.
 *
 * Keyed on `expiresAt` directly rather than gated on `acceptedAt` being unset: `accept()`
 * (`InvitationsService`) never extends `expiresAt`, so a redeemed invitation is removed at the same
 * original cutoff an unredeemed one would have been, whether or not it was ever used. That is deliberate —
 * the durable record of who accepted an invitation and when already lives in `audit_events`
 * (`invitations.accepted`, written by `accept` itself), so the invitation document is disposable
 * token state once its window closes, not the record of what happened.
 *
 * Declared here as well as in `invitation.schema.ts`, with the same key, options and name — the
 * migration builds it in a deployed database, the schema declaration is what `Model.syncIndexes()`
 * builds for a test lane that never runs migrations.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ expiresAt: 1 }, { name: EXPIRES_AT_TTL_INDEX, expireAfterSeconds: 0 });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(EXPIRES_AT_TTL_INDEX);
};
