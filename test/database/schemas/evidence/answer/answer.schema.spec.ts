import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../../src/database/constants/tenant.constant';
import {
  Answer,
  AnswerSchema,
} from '../../../../../src/database/schemas/evidence/answer/answer.schema';

jest.setTimeout(60000);

const answeredOutcome = {
  kind: 'answered' as const,
  claims: [
    {
      statement: 'Revenue grew 12% year over year.',
      citations: [
        {
          docVersionId: new mongoose.Types.ObjectId().toString(),
          sha256: 'a'.repeat(64),
          chunkId: new mongoose.Types.ObjectId().toString(),
          locator: { kind: 'pdf-page' as const, extractorVersion: 'pdf-extractor@1.0.0', page: 3 },
          quote: 'Revenue grew 12% year over year.',
        },
      ],
    },
  ],
};

describe('Answer schema', () => {
  describe('validation (offline — no database connection)', () => {
    const AnswerModel = mongoose.model<Answer>('AnswerValidationOnly', AnswerSchema);

    it('requires questionText and defaults runStatus to queued', () => {
      const answer = new AnswerModel({});

      const error = answer.validateSync();

      expect(error?.errors.questionText).toBeDefined();
      expect(answer.runStatus).toBe('queued');
    });

    // The two-axis invariant lives in a `pre('validate')` hook, and `validateSync()` skips
    // middleware by design — asserting through it would report success no matter what the hook
    // does. These two use the async form so they actually exercise the guard.
    it('rejects an outcome set while runStatus is not completed — the two-axis invariant', async () => {
      const answer = new AnswerModel({
        questionText: 'What was Q3 revenue?',
        runStatus: 'running',
        outcome: answeredOutcome,
      });

      await expect(answer.validate()).rejects.toThrow(/outcome may only be set/);
    });

    it('accepts an outcome once runStatus is completed', async () => {
      const answer = new AnswerModel({
        questionText: 'What was Q3 revenue?',
        runStatus: 'completed',
        outcome: answeredOutcome,
      });

      await expect(answer.validate()).resolves.toBeUndefined();
    });

    it('defaults tenantId to DEFAULT_TENANT_ID', () => {
      const answer = new AnswerModel({ questionText: 'What was Q3 revenue?' });

      expect(answer.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let AnswerModel: Model<Answer>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      AnswerModel = connection.model<Answer>(Answer.name, AnswerSchema);
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it('persists and rehydrates a completed answer with its verification metadata', async () => {
      const created = await AnswerModel.create({
        questionText: 'What was Q3 revenue?',
        runStatus: 'completed',
        outcome: answeredOutcome,
        claims: answeredOutcome.claims,
        claimCoverage: 1,
        verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
      });

      const found = await AnswerModel.findById(created._id);

      expect(found?.runStatus).toBe('completed');
      expect(found?.claimCoverage).toBe(1);
      expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });
});
