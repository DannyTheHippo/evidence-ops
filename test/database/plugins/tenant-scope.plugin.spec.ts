import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, createConnection, Model, Schema } from 'mongoose';
import { tenantScopePlugin } from '../../../src/database/plugins/tenant-scope.plugin';
import { AlsContext } from '../../../src/shared/types/als-context.type';

// MongoMemoryServer boot (binary spin-up + replica init) regularly exceeds Jest's 5s default.
jest.setTimeout(60000);

interface TenantScopedTestDocProps {
  name: string;
  tenantId?: string;
}

interface UnscopedTestDocProps {
  name: string;
}

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

describe('tenantScopePlugin', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let TestModel: Model<TenantScopedTestDocProps>;
  let UnscopedModel: Model<UnscopedTestDocProps>;
  const als = new AsyncLocalStorage<AlsContext>();

  // Mirrors what AsyncLocalStorageMiddleware + JwtAuthGuard establish per-request: an ALS
  // store carrying the authenticated tenant, active for the whole async call underneath.
  const runAsTenant = <T>(tenant: string, fn: () => Promise<T>): Promise<T> =>
    als.run({ 'correlation-id': 'test-correlation-id', tenant }, fn);

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await createConnection(mongod.getUri()).asPromise();
    connection.plugin(tenantScopePlugin(als));

    // `default` mirrors the real schemas (e.g. `evidence-chunk.schema.ts`), which all declare
    // `default: DEFAULT_TENANT_ID` on `tenantId`. It matters here: without a schema default,
    // Mongoose never marks an unset path as "default" state, so `$isDefault('tenantId')` in the
    // plugin would stay false and the save-stamp hook would never fire — verified against
    // `node_modules/mongoose/lib/document.js`.
    const tenantScopedSchema = new Schema<TenantScopedTestDocProps>({
      name: { type: String, required: true },
      tenantId: { type: String, default: 'schema-default' },
    });
    TestModel = connection.model<TenantScopedTestDocProps>(
      'TenantScopedTestDoc',
      tenantScopedSchema,
    );

    // No `tenantId` path at all — the plugin's `schema.path('tenantId')` gate must skip this
    // schema entirely rather than a global `connection.plugin` hitting every model regardless
    // of whether it has a tenant concept.
    const unscopedSchema = new Schema<UnscopedTestDocProps>({
      name: { type: String, required: true },
    });
    UnscopedModel = connection.model<UnscopedTestDocProps>('UnscopedTestDoc', unscopedSchema);
  });

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await TestModel.deleteMany({});
    await UnscopedModel.deleteMany({});
  });

  it('scopes find/findOne/findById/countDocuments to the ALS tenant', async () => {
    const [aDoc1, aDoc2] = await runAsTenant(TENANT_A, () =>
      TestModel.create([{ name: 'a1' }, { name: 'a2' }]),
    );
    const [bDoc1] = await runAsTenant(TENANT_B, () => TestModel.create([{ name: 'b1' }]));

    const found = await runAsTenant(TENANT_A, () => TestModel.find({}).exec());
    expect(found.map((doc) => doc.name).sort()).toEqual(['a1', 'a2']);

    const foundOne = await runAsTenant(TENANT_A, () => TestModel.findOne({ name: 'a1' }).exec());
    expect(foundOne?._id).toEqual(aDoc1._id);

    const foundByForeignId = await runAsTenant(TENANT_A, () =>
      TestModel.findById(bDoc1._id).exec(),
    );
    expect(foundByForeignId).toBeNull();

    const foundByOwnId = await runAsTenant(TENANT_A, () => TestModel.findById(aDoc2._id).exec());
    expect(foundByOwnId?._id).toEqual(aDoc2._id);

    const count = await runAsTenant(TENANT_A, () => TestModel.countDocuments({}).exec());
    expect(count).toBe(2);
  });

  it('returns nothing for an $or filter naming only foreign-tenant ids — proves intersection, not overwrite', async () => {
    await runAsTenant(TENANT_A, () => TestModel.create({ name: 'a1' }));
    const [bDoc1, bDoc2] = await runAsTenant(TENANT_B, () =>
      TestModel.create([{ name: 'b1' }, { name: 'b2' }]),
    );

    // A naive `filter.tenantId = ownTenant` assignment composes fine with a top-level `$or` too
    // (Mongo ANDs top-level keys), but `$and: [filter, { tenantId }]` is what keeps this correct
    // regardless of what shape the caller's filter takes — this pins that the $or branch is not
    // stripped or bypassed by the intersection.
    const results = await runAsTenant(TENANT_A, () =>
      TestModel.find({ $or: [{ _id: bDoc1._id }, { _id: bDoc2._id }] }).exec(),
    );
    expect(results).toHaveLength(0);
  });

  it('returns the empty set when an explicit tenantId predicate contradicts the ALS tenant', async () => {
    await runAsTenant(TENANT_A, () => TestModel.create({ name: 'a1' }));

    const results = await runAsTenant(TENANT_A, () =>
      TestModel.find({ tenantId: TENANT_B }).exec(),
    );
    expect(results).toHaveLength(0);
  });

  it('prevents findOneAndUpdate and deleteOne from touching a foreign-tenant row', async () => {
    const [bDoc] = await runAsTenant(TENANT_B, () => TestModel.create([{ name: 'b1' }]));

    const updated = await runAsTenant(TENANT_A, () =>
      TestModel.findOneAndUpdate({ _id: bDoc._id }, { name: 'hijacked' }, { new: true }).exec(),
    );
    expect(updated).toBeNull();

    const deleteResult = await runAsTenant(TENANT_A, () =>
      TestModel.deleteOne({ _id: bDoc._id }).exec(),
    );
    expect(deleteResult.deletedCount).toBe(0);

    const stillThere = await runAsTenant(TENANT_B, () => TestModel.findById(bDoc._id).exec());
    expect(stillThere?.name).toBe('b1');
  });

  it('stamps the ALS tenant on save for a defaulted document, and never overrides an explicit tenantId', async () => {
    const stamped = await runAsTenant(TENANT_A, () => new TestModel({ name: 'new' }).save());
    expect(stamped.tenantId).toBe(TENANT_A);

    // The worker and eval harness set `tenantId` explicitly and deliberately — the hook must
    // not override that value even when a (different) tenant happens to be in the ALS store.
    const explicit = new TestModel({ name: 'explicit', tenantId: TENANT_B });
    const saved = await runAsTenant(TENANT_A, () => explicit.save());
    expect(saved.tenantId).toBe(TENANT_B);
  });

  it('leaves the query unscoped with no ALS store — documented contract, not a bug', async () => {
    await runAsTenant(TENANT_A, () => TestModel.create({ name: 'a1' }));
    await runAsTenant(TENANT_B, () => TestModel.create({ name: 'b1' }));

    // No `als.run` wrapper at all: migrations, seeds, and background jobs run this way and
    // legitimately pass tenant scope some other way, or not at all — a fail-closed default here
    // would break them all. This is the same no-op contract as `auditablePlugin`.
    const results = await TestModel.find({}).exec();
    expect(results.map((doc) => doc.name).sort()).toEqual(['a1', 'b1']);
  });

  it('leaves the query unscoped when it is awaited after the ALS scope exits — documented contract, not a bug', async () => {
    await runAsTenant(TENANT_A, () => TestModel.create({ name: 'a1' }));
    await runAsTenant(TENANT_B, () => TestModel.create({ name: 'b1' }));

    // A Mongoose Query is lazy: the `pre('find')` hook fires at `.exec()`/`await`, not at
    // construction. `als.run` here wraps a *synchronous* callback, so it captures the
    // unexecuted Query and exits the ALS scope before the callback's caller ever awaits it —
    // by the time `query` is awaited below, there is no tenant in the store.
    const query = als.run({ 'correlation-id': 'test-correlation-id', tenant: TENANT_A }, () =>
      TestModel.find({}),
    );
    const results = await query;
    expect(results.map((doc) => doc.name).sort()).toEqual(['a1', 'b1']);
  });

  it('does not register scoping hooks on a schema with no tenantId path', async () => {
    await UnscopedModel.create({ name: 'unscoped-doc' });

    const results = await runAsTenant(TENANT_A, () => UnscopedModel.find({}).exec());
    expect(results).toHaveLength(1);
  });
});
