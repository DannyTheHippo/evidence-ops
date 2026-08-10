import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../../src/database/constants/tenant.constant';
import {
  WorkflowRun,
  WorkflowRunSchema,
} from '../../../../../src/database/schemas/workflow/workflow-run/workflow-run.schema';

jest.setTimeout(60000);

describe('WorkflowRun schema', () => {
  describe('validation (offline — no database connection)', () => {
    const WorkflowRunModel = mongoose.model<WorkflowRun>(
      'WorkflowRunValidationOnly',
      WorkflowRunSchema,
    );

    it('requires workflowId and defaults status to queued', () => {
      const run = new WorkflowRunModel({});

      const error = run.validateSync();

      expect(error?.errors.workflowId).toBeDefined();
      expect(run.status).toBe('queued');
    });

    it('rejects a status outside queued/running/completed/failed', () => {
      const run = new WorkflowRunModel({ workflowId: 'wf-1', status: 'paused' });

      const error = run.validateSync();

      expect(error?.errors.status).toBeDefined();
    });

    it('defaults tenantId to DEFAULT_TENANT_ID', () => {
      const run = new WorkflowRunModel({ workflowId: 'wf-1' });

      expect(run.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let WorkflowRunModel: Model<WorkflowRun>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      WorkflowRunModel = connection.model<WorkflowRun>(WorkflowRun.name, WorkflowRunSchema);
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it('persists and rehydrates a running workflow projection', async () => {
      const answerId = new mongoose.Types.ObjectId();

      const created = await WorkflowRunModel.create({
        workflowId: 'wf-1',
        runId: 'run-1',
        status: 'running',
        currentStep: 'retrieve',
        answerId,
      });

      const found = await WorkflowRunModel.findById(created._id);

      expect(found?.status).toBe('running');
      expect(found?.answerId?.equals(answerId)).toBe(true);
      expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });
});
