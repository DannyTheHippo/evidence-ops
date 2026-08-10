import type { Db } from 'mongodb';

const COLLECTION = 'users';
const EMAIL_INDEX = 'users_email_unique';

/**
 * Baseline schema constraints. The Mongoose schema also declares `unique` on `email`, but that
 * only materialises when autoIndex is on — which it must not be in production, where index
 * builds belong in a reviewed migration rather than in application boot.
 */
export const up = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).createIndex({ email: 1 }, { unique: true, name: EMAIL_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(EMAIL_INDEX);
};
