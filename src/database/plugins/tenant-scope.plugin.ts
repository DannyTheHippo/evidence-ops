import type { Document, Query, Schema } from 'mongoose';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { AlsContext } from '../../shared/types/als-context.type';

/**
 * Global Mongoose plugin: the STRUCTURAL BACKSTOP for multi-tenant isolation, applied only to
 * schemas that declare a `tenantId` path. Explicit-tenant service parameters remain the primary
 * control — this plugin exists to catch a query someone forgot to scope, not to replace scoping.
 *
 * Fail-open / fail-closed asymmetry, and why each direction is deliberate:
 * - **No tenant in the ALS store -> no-op (fail OPEN).** The Temporal worker, the eval harness,
 *   migrations, and seed scripts all run with no request context and pass their tenant
 *   explicitly. A fail-closed default here would break all four of those paths outright.
 * - **Tenant present -> intersect, never overwrite (fail CLOSED on disagreement).**
 *   `this.setQuery({ $and: [this.getFilter(), { tenantId }] })` rather than
 *   `filter.tenantId = tenantId`. Assignment would silently replace a caller's own predicate
 *   (corrupting `$or`/`$in` filters) and would let a filter that names a foreign tenant "win".
 *   Intersection makes a contradicting explicit predicate yield the empty set instead. One
 *   exception: when the filter already carries a top-level, own, strict-equality `tenantId` that
 *   matches the ALS tenant, the hook leaves the filter untouched instead of intersecting.
 *   MongoDB cannot derive an insert document for an upsert whose filter matches `tenantId` twice
 *   — even when both occurrences agree — so intersecting an already-agreeing filter would break
 *   every scoped upsert. Any other shape (a different tenant, an operator such as `$in`,
 *   `tenantId` nested inside `$or`/`$and`, or no `tenantId` in the filter at all) still
 *   intersects exactly as before, so a filter naming a foreign tenant still yields nothing.
 *
 * Unlike `auditablePlugin`, where a missed ALS context costs a missing audit stamp, a missed
 * scope here costs a LEAK across tenants. That is why the explicit-tenant parameters threaded
 * through the service layer are the primary control and this plugin is only the backstop —
 * it exists to fail safe when that primary control is forgotten, not to replace it.
 *
 * What this plugin CANNOT intercept — the explicit-tenant parameters remain load-bearing here:
 * - `aggregate()` is deliberately NOT hooked. `$search`/`$vectorSearch`/`$rankFusion` must be the
 *   first stage of a pipeline, so a prepended `$match` would break hybrid retrieval outright.
 *   `MongoHybridRetrievalStore` already fails closed on a missing `filter.tenantId`
 *   (`src/providers/retrieval/mongo-hybrid.store.ts`, `extractTenantId`) — that check is the
 *   control on that path, not this plugin.
 * - Driver-level access bypasses Mongoose entirely: the GridFS bucket in
 *   `src/providers/storage/gridfs-document.store.ts` is not a Mongoose model and this plugin
 *   never runs against it.
 * - `insertMany` has no query to scope (it is a passthrough of documents). Verified call sites
 *   (`grep -rn "insertMany" src`): three, all worker-context, all setting `tenantId` explicitly
 *   on every inserted document — `ingestion.service.ts` (`evidenceChunkModel`),
 *   `conflicts.service.ts` (`conflictModel`), `facts.service.ts` (`extractedFactModel`).
 * - `bulkWrite`/`estimatedDocumentCount` have zero call sites in `src/` as of writing (verified).
 * - `document.save()` after a fetch is safe only because the fetch that produced the document
 *   was itself scoped — a save cannot leak a document a scoped query never returned.
 * - A query built inside a request but awaited after the ALS scope exits runs unscoped, for the
 *   same laziness reason documented on `auditablePlugin`: the hook fires at `.exec()`/`await`,
 *   not at construction.
 *
 * `pre('validate')` stamps `tenantId` only on a genuinely new, unset document
 * (`this.isNew && this.get('tenantId') == null`) — it never overrides a value the worker or eval
 * harness set deliberately. The loose `== null` check catches both `null` and `undefined` so a
 * caller that explicitly passes either still gets stamped. The hook runs on `validate` rather
 * than `save` because Mongoose's `required` validator runs before any `pre('save')` hook fires:
 * stamping on `save` would always be too late to satisfy `required: true` on `tenantId`.
 *
 * `findOneAndUpdate`/`updateOne`/etc. with `upsert: true` is not otherwise specially handled: an
 * insert via upsert gets whatever `tenantId` the filter or the update document supplies, never
 * one supplied by this plugin. The already-agreeing-filter exception above only stops the filter
 * from acquiring a second, duplicate `tenantId` predicate — it never adds one that was not
 * already there. That is covered by the same primary-control argument as everything else above —
 * the explicit-tenant service parameters are what get this right.
 */
export const tenantScopePlugin =
  (als: AsyncLocalStorage<AlsContext>) =>
  (schema: Schema): void => {
    if (!schema.path('tenantId')) {
      return;
    }

    schema.pre(
      [
        'find',
        'findOne',
        'countDocuments',
        'distinct',
        'findOneAndUpdate',
        'findOneAndDelete',
        'findOneAndReplace',
        'updateOne',
        'updateMany',
        'deleteOne',
        'deleteMany',
        'replaceOne',
      ],
      function (this: Query<unknown, unknown>): void {
        const tenantId = als.getStore()?.tenant;
        if (!tenantId) {
          return;
        }

        const filter = this.getFilter();
        if (
          Object.hasOwn(filter, 'tenantId') &&
          (filter as { tenantId: unknown }).tenantId === tenantId
        ) {
          return;
        }

        this.setQuery({ $and: [filter, { tenantId }] });
      },
    );

    schema.pre('validate', function (this: Document): void {
      const tenantId = als.getStore()?.tenant;
      if (tenantId && this.isNew && this.get('tenantId') == null) {
        this.set('tenantId', tenantId);
      }
    });
  };
