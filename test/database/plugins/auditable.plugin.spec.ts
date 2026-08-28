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

  it('stamps updatedBy via updateOne, leaving createdBy from the original creator untouched', async () => {
    const creatorId = new Types.ObjectId().toString();
    const editorId = new Types.ObjectId().toString();

    const created = await runAs(creatorId, () =>
      TestModel.create({ email: 'update-one@example.com' }),
    );

    await runAs(editorId, () =>
      TestModel.updateOne({ _id: created._id }, { email: 'update-one-changed@example.com' }).exec(),
    );

    const updated = await TestModel.findById(created._id).exec();
    expect(updated?.createdBy?.toString()).toBe(creatorId);
    expect(updated?.updatedBy?.toString()).toBe(editorId);
  });

  it('stamps updatedBy via updateMany across every matched document', async () => {
    const creatorId = new Types.ObjectId().toString();
    const editorId = new Types.ObjectId().toString();

    await runAs(creatorId, () =>
      TestModel.create([
        { email: 'update-many-1@example.com' },
        { email: 'update-many-2@example.com' },
      ]),
    );

    await runAs(editorId, () =>
      TestModel.updateMany(
        { email: { $in: ['update-many-1@example.com', 'update-many-2@example.com'] } },
        { $set: { email: 'update-many-changed@example.com' } },
      ).exec(),
    );

    const updated = await TestModel.find({
      email: 'update-many-changed@example.com',
    }).exec();
    expect(updated).toHaveLength(2);
    expect(updated.every((doc) => doc.updatedBy?.toString() === editorId)).toBe(true);
  });

  it('stamps createdBy on the document an updateOne upsert creates', async () => {
    const userId = new Types.ObjectId().toString();

    await runAs(userId, () =>
      TestModel.updateOne(
        { email: 'upserted@example.com' },
        { email: 'upserted@example.com' },
        { upsert: true },
      ).exec(),
    );

    const created = await TestModel.findOne({ email: 'upserted@example.com' }).exec();
    expect(created?.createdBy?.toString()).toBe(userId);
    expect(created?.updatedBy?.toString()).toBe(userId);
  });

  it('stamps createdBy and updatedBy on every document inserted via insertMany', async () => {
    const userId = new Types.ObjectId().toString();

    const docs = await runAs(userId, () =>
      TestModel.insertMany([
        { email: 'insert-many-1@example.com' },
        { email: 'insert-many-2@example.com' },
      ]),
    );

    expect(docs.every((doc) => doc.createdBy?.toString() === userId)).toBe(true);
    expect(docs.every((doc) => doc.updatedBy?.toString() === userId)).toBe(true);
  });

  it('leaves createdBy/updatedBy unset on insertMany with no ALS context — fail-open contract', async () => {
    const docs = await TestModel.insertMany([{ email: 'insert-many-no-context@example.com' }]);

    expect(docs[0].createdBy).toBeUndefined();
    expect(docs[0].updatedBy).toBeUndefined();
  });
});
