import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Client, Connection, type WorkflowExecutionStatusName } from '@temporalio/client';
import { randomUUID } from 'node:crypto';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import type { WorkflowEngine, WorkflowHandle, WorkflowStatus } from './workflow-engine.interface';

function toWorkflowStatus(name: WorkflowExecutionStatusName): WorkflowStatus {
  switch (name) {
    case 'RUNNING':
    case 'CONTINUED_AS_NEW':
      return 'running';
    case 'COMPLETED':
      return 'completed';
    default:
      // FAILED, CANCELLED, TERMINATED, TIMED_OUT, PAUSED, UNSPECIFIED, UNKNOWN — every
      // non-successful or indeterminate terminal state collapses to 'failed' rather than
      // widening `WorkflowStatus` for distinctions nothing in this codebase branches on yet.
      return 'failed';
  }
}

/**
 * Real `WorkflowEngine` binding via `@temporalio/client`. This is what `ProvidersModule` binds
 * `WORKFLOW_ENGINE` to (ADR-0003) — `QaService.startQuestion` calls `start()` on it for the real
 * answer workflow. `test/utils/create-test-app.ts` overrides the token back to
 * `FakeWorkflowEngine` for e2e, so the suite never dials a Temporal server.
 *
 * `Connection.connect()` is deferred to first use (`getClient()`) rather than the constructor:
 * instantiating this class never attempts a network connection, only calling `start`/`status`
 * does.
 */
@Injectable()
export class TemporalWorkflowEngine implements WorkflowEngine, OnModuleDestroy {
  private connectionPromise: Promise<Connection> | undefined;

  constructor(private readonly config: TypedConfigService) {}

  async start(workflowType: string, input: unknown): Promise<WorkflowHandle> {
    const client = await this.getClient();
    const handle = await client.workflow.start(workflowType, {
      taskQueue: this.config.temporal.taskQueue,
      workflowId: randomUUID(),
      args: [input],
    });

    return { id: handle.workflowId, status: 'running' };
  }

  async status(id: string): Promise<WorkflowHandle> {
    const client = await this.getClient();
    const description = await client.workflow.getHandle(id).describe();

    return { id, status: toWorkflowStatus(description.status.name) };
  }

  /** Mirrors `mongo.config.ts`'s `stopInMemoryMongo` concern: an opened connection left unclosed
   *  outlives the module that opened it. */
  async onModuleDestroy(): Promise<void> {
    if (!this.connectionPromise) {
      return;
    }
    const connection = await this.connectionPromise;
    await connection.close();
  }

  private async getClient(): Promise<Client> {
    this.connectionPromise ??= Connection.connect({ address: this.config.temporal.address });
    const connection = await this.connectionPromise;
    return new Client({ connection, namespace: this.config.temporal.namespace });
  }
}
