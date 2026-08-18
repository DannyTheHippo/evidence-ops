import type { Db } from 'mongodb';

const COLLECTION = 'api_keys';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Matches `API_KEY_DEFAULT_TTL_DAYS`'s deployed default (`environment.config.ts`) — every
 * pre-migration key backfills to the same window a key minted today gets when it carries no
 * explicit expiry, rather than inventing a separate grace period for keys that predate expiry
 * existing at all.
 */
const BACKFILL_TTL_DAYS = 90;
const BACKFILL_TTL_MS = BACKFILL_TTL_DAYS * MS_PER_DAY;

/**
 * `ApiKey.expiresAt` (added by `migrations/0021-api-key-expiry-and-usage.ts`) was never backfilled,
 * so a key minted before that deploy has no `expiresAt` at all. `ApiKeysService.verify` only
 * rejects a key when `expiresAt` is truthy, and `assertUnderActiveKeyCap` treats
 * `expiresAt: { $exists: false }` as active — both correct against a schema that always sets the
 * field, both silently wrong against one that doesn't: a pre-migration key never expires and
 * occupies a cap slot forever.
 *
 * Sets `expiresAt` to `createdAt + 90 days` on every row still missing it — the same window
 * `mint()`'s own `defaultExpiresAt()` gives a key created today with no explicit expiry, applied
 * retroactively rather than invented fresh for this backfill. A pre-existing key more than 90 days
 * old expires the moment this runs, forcing a re-mint; one still inside that window keeps working
 * for whatever of it remains. An aggregation-pipeline update (`$add` against the row's own
 * `createdAt`) is required here because the target value differs per row — there is no single
 * constant to `$set`.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .updateMany({ expiresAt: { $exists: false } }, [
      { $set: { expiresAt: { $add: ['$createdAt', BACKFILL_TTL_MS] } } },
    ]);
};

export const down = async (db: Db): Promise<void> => {
  // Scoped to rows whose `expiresAt` is still exactly `createdAt + 90 days` — the value this
  // migration's own `up` wrote via `$expr`, not an unconditional `$unset`. A key minted after this
  // migration through `mint()`'s own `defaultExpiresAt()` computes the identical value when given no
  // explicit expiry, so this cannot distinguish "backfilled by this migration" from "defaulted by
  // `mint()` to the same window" — both read as "no explicit expiry was ever chosen" for that row,
  // and reverting either to eternal is correct. A key whose expiry was explicitly set to something
  // else never matches this filter and is left untouched.
  await db
    .collection(COLLECTION)
    .updateMany(
      { $expr: { $eq: ['$expiresAt', { $add: ['$createdAt', BACKFILL_TTL_MS] }] } },
      { $unset: { expiresAt: '' } },
    );
};
