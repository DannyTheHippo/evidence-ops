import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WorkflowEngine, WorkflowHandle, WorkflowStatus } from './workflow-engine.interface';

/** Test double: in-memory `Map`, starts every workflow as `completed` unless overridden. */
@Injectable()
export class FakeWorkflowEngine implements WorkflowEngine {
  readonly started: { workflowType: string; input: unknown }[] = [];

  /** Recorded so a test can assert what a caller signalled without a real Temporal server —
   *  mirrors `started`'s own reasoning. */
  readonly signals: { id: string; signalName: string; payload: unknown }[] = [];

  private readonly handles = new Map<string, WorkflowHandle>();

  setStatus(id: string, status: WorkflowStatus): void {
    const existing = this.handles.get(id);
    if (existing) {
      this.handles.set(id, { ...existing, status });
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async start(workflowType: string, input: unknown): Promise<WorkflowHandle> {
    this.started.push({ workflowType, input });
    const handle: WorkflowHandle = { id: randomUUID(), status: 'completed' };
    this.handles.set(handle.id, handle);
    return handle;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async status(id: string): Promise<WorkflowHandle> {
    const handle = this.handles.get(id);
    if (!handle) {
      throw new Error(`FakeWorkflowEngine has no workflow with id '${id}'`);
    }
    return handle;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async signal(id: string, signalName: string, payload: unknown): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) {
      throw new Error(`FakeWorkflowEngine has no workflow with id '${id}'`);
    }
    this.signals.push({ id, signalName, payload });
  }
}
