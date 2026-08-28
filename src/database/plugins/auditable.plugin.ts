import type { AsyncLocalStorage } from 'node:async_hooks';
import type { Document, Query, Schema } from 'mongoose';
import { AlsContext } from '../../shared/types/als-context.type';

/**
 * Global Mongoose plugin: stamps `createdBy`/`updatedBy` from the authenticated user carried
 * in AsyncLocalStorage (populated by JwtAuthGuard for the current request). Migrations, seeds,
 * and background jobs run outside a request context — no ALS store, or no `user` on it, is a
 * silent no-op, never a thrown error.
 *
 * Mongoose 9's `pre` middleware is promise-native (Kareem awaits the returned value or the
 * function's synchronous completion) — there is no `next` callback parameter to invoke.
 *
 * Caller contract for query middleware: a Mongoose Query is lazy — the hook runs at execution
 * (`.then()`/`.exec()`), not at construction. A query built inside a request but awaited outside
 * the ALS scope therefore stamps nothing. Nest handlers keep the whole chain inside the request's
 * async context so this holds naturally; hand-rolled deferred queries must not.
 */
export const auditablePlugin =
  (als: AsyncLocalStorage<AlsContext>) =>
  (schema: Schema): void => {
    schema.pre('save', function (this: Document): void {
      const userId = als.getStore()?.user;
      if (userId) {
        if (this.isNew) {
          this.set('createdBy', userId);
        }
        this.set('updatedBy', userId);
      }
    });

    schema.pre(
      ['findOneAndUpdate', 'updateOne', 'updateMany'],
      function (this: Query<unknown, unknown>): void {
        const userId = als.getStore()?.user;
        if (!userId) {
          return;
        }

        this.set('updatedBy', userId);

        // `$setOnInsert` only ever takes effect on the insert an upsert produces — injecting it
        // on a call that cannot upsert would leave dead weight on every plain update this schema
        // issues for no observable effect.
        if (this.getOptions().upsert !== true) {
          return;
        }

        const update = this.getUpdate();
        if (update && !Array.isArray(update)) {
          update.$setOnInsert = { ...update.$setOnInsert, createdBy: userId };
        }
      },
    );

    schema.pre('insertMany', function (docs: unknown): void {
      const userId = als.getStore()?.user;
      if (!userId) {
        return;
      }

      // `insertMany` hands the pre-hook the raw docs (never a `Document[]` yet), as a single
      // object or an array depending on how the caller invoked it — every one of them is a new
      // record by definition, so both fields are stamped the same way `save` stamps a new
      // document, with no `isNew` branch to check.
      const documents = Array.isArray(docs) ? docs : [docs];
      for (const doc of documents) {
        if (doc && typeof doc === 'object') {
          const record = doc as Record<string, unknown>;
          record.createdBy = userId;
          record.updatedBy = userId;
        }
      }
    });
  };
