import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, createConnection, Model, Schema, Types } from 'mongoose';
import { auditablePlugin } from '../../../src/database/plugins/auditable.plugin';
import { AlsContext } from '../../../src/shared/types/als-context.type';

// MongoMemoryServer boot (binary spin-up + replica init) regularly exceeds Jest's 5s default.
jest.setTimeout(60000);

interface AuditableTestDocProps {
  email: string;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
}

describe('auditablePlugin', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let TestModel: Model<AuditableTestDocProps>;
  const als = new AsyncLocalStorage<AlsContext>();

  // Mirrors what AsyncLocalStorageMiddleware + JwtAuthGuard establish per-request: an ALS
  // store carrying the authenticated user, active for the whole async call underneath.
  const runAs = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    als.run({ 'correlation-id': 'test-correlation-id', user: userId }, fn);

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await createConnection(mongod.getUri()).asPromise();
    connection.plugin(auditablePlugin(als));

    const schema = new Schema<AuditableTestDocProps>({
      email: { type: String, required: true },
      createdBy: { type: Types.ObjectId },
      updatedBy: { type: Types.ObjectId },
    });

    TestModel = connection.model<AuditableTestDocProps>('AuditableTestDoc', schema);
  });

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it('stamps both createdBy and updatedBy from the ALS user on insert', async () => {
    const userId = new Types.ObjectId().toString();

    const doc = await runAs(userId, () => TestModel.create({ email: 'insert@example.com' }));

    expect(doc.createdBy?.toString()).toBe(userId);
    expect(doc.updatedBy?.toString()).toBe(userId);
  });

  it('stamps updatedBy on a subsequent save and leaves createdBy unchanged', async () => {
    const creatorId = new Types.ObjectId().toString();
    const editorId = new Types.ObjectId().toString();

    const doc = await runAs(creatorId, () => TestModel.create({ email: 'update@example.com' }));

    doc.email = 'update-changed@example.com';
    await runAs(editorId, () => doc.save());

    expect(doc.createdBy?.toString()).toBe(creatorId);
    expect(doc.updatedBy?.toString()).toBe(editorId);
  });

  it('stamps updatedBy via findOneAndUpdate', async () => {
    const creatorId = new Types.ObjectId().toString();
    const editorId = new Types.ObjectId().toString();

    const created = await runAs(creatorId, () =>
      TestModel.create({ email: 'find-one-and-update@example.com' }),
    );

    // `.exec()` must be called INSIDE the ALS scope. A Mongoose Query is lazy: returning it
    // unexecuted from `als.run` defers execution to the `await`, by which point the scope has
    // exited and the hook sees no store. Verified: unexecuted -> no stamp, exec'd -> stamped.
    const updated = await runAs(editorId, async () =>
      TestModel.findOneAndUpdate(
        { _id: created._id },
        { email: 'find-one-and-update-changed@example.com' },
        { returnDocument: 'after' },
      ).exec(),
    );

    expect(updated?.updatedBy?.toString()).toBe(editorId);
  });

  it('leaves createdBy/updatedBy unset when there is no ALS context — fail-open contract', async () => {
    const doc = await TestModel.create({ email: 'no-context@example.com' });

    expect(doc.createdBy).toBeUndefined();
    expect(doc.updatedBy).toBeUndefined();
  });
});
