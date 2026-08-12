import type { AsyncLocalStorage } from 'node:async_hooks';
import type { Document, Query, Schema } from 'mongoose';
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
 *   Intersection makes a contradicting explicit predicate yield the empty set instead.
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
 * `pre('save')` stamps `tenantId` only on a genuinely new, unset document
 * (`this.isNew && this.$isDefault('tenantId')`) — it never overrides a value the worker or eval
 * harness set deliberately. `$isDefault` reports "unset" only when the schema itself declares a
 * `default` for `tenantId` (every current tenant-scoped schema does, e.g.
 * `evidence-chunk.schema.ts`'s `default: DEFAULT_TENANT_ID`) — Mongoose applies that default at
 * construction and marks the path as still-default until something assigns over it. A tenant
 * schema added later without a `default` on `tenantId` would make this stamp a permanent no-op;
 * that is a schema-authoring contract this plugin depends on, not something it can enforce.
 *
 * `findOneAndUpdate`/`updateOne`/etc. with `upsert: true` is not specially handled: an insert via
 * upsert gets whatever `tenantId` the intersected filter or the update document supplies, never
 * one supplied by this plugin. That is covered by the same primary-control argument as
 * everything else above — the explicit-tenant service parameters are what get this right.
 */
export const tenantScopePlugin =
  (als: AsyncLocalStorage<AlsContext>) =>
  (schema: Schema): void => {
    if (!schema.path('tenantId')) {
      return;
    }

    const scopeQuery = function (this: Query<unknown, unknown>): void {
      const tenantId = als.getStore()?.tenant;
      if (tenantId) {
        this.setQuery({ $and: [this.getFilter(), { tenantId }] });
      }
    };

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
      scopeQuery,
    );

    schema.pre('save', function (this: Document): void {
      const tenantId = als.getStore()?.tenant;
      if (tenantId && this.isNew && this.$isDefault('tenantId')) {
        this.set('tenantId', tenantId);
      }
    });
  };
