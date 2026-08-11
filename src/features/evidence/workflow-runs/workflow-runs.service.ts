import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import {
  WorkflowRun,
  WorkflowRunDocument,
  type WorkflowRunStatus,
} from '../../../database/schemas/workflow/workflow-run/workflow-run.schema';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { WorkflowRunNotFoundException } from './exceptions/workflow-runs.exception';

export interface CreateWorkflowRunInput {
  readonly workflowId: string;
  readonly status: WorkflowRunStatus;
  readonly tenantId?: string;
}

export interface WorkflowRunResult {
  readonly id: string;
  readonly workflowId: string;
  readonly status: WorkflowRunStatus;
  readonly currentStep?: string;
  readonly errorMessage?: string;
  readonly createdAt: Date;
}

@Injectable()
export class WorkflowRunsService {
  constructor(
    @InjectModel(WorkflowRun.name)
    private readonly workflowRunModel: Model<WorkflowRunDocument>,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(WorkflowRunsService.name);
  }

  /**
   * Creates the durable projection a caller who just started a workflow (D3's `POST
   * /conflicts/:id/resolution-requests`, `ConflictsService.requestResolution`) hands back so a
   * client has an id to poll `GET /workflow-runs/:id` with — this is the first writer this
   * collection has ever had; nothing else in the codebase creates a `WorkflowRun` row yet.
   */
  async create(input: CreateWorkflowRunInput): Promise<WorkflowRunResult> {
    const run = await this.workflowRunModel.create({
      workflowId: input.workflowId,
      status: input.status,
      tenantId: input.tenantId,
    });

    return this.toResult(run);
  }

  /**
   * Tenant-scoped read of the durable row, refreshed best-effort against the live engine status.
   * FAILS OPEN on the engine call: `WorkflowEngine.status()` is a measurement of a downstream
   * system's state for display, never a permission gate on anything — a Temporal outage or a
   * stale/expired handle must not turn a legitimate poll of an already-known run into an error, so
   * an engine failure is logged and the durable (possibly stale) row is returned as-is. Never
   * written back to Mongo: this method only merges the live status into the response it returns,
   * so a GET here stays a read, and the persisted row remains whatever the workflow's own
   * activities last recorded.
   */
  async findById(
    id: string,
    actorId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<WorkflowRunResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new WorkflowRunNotFoundException(`WorkflowRun '${id}' not found`);
    }

    const run = await this.workflowRunModel.findOne({ _id: id, tenantId });
    if (!run) {
      throw new WorkflowRunNotFoundException(`WorkflowRun '${id}' not found`);
    }

    let liveStatus: WorkflowRunStatus = run.status;
    try {
      const handle = await this.workflowEngine.status(run.workflowId);
      liveStatus = handle.status;
    } catch (error) {
      this.logger.warn(
        `Could not refresh live status for workflow run '${id}' (workflow '${run.workflowId}'): ${(error as Error).message}`,
      );
    }

    await this.auditService.record({
      action: 'workflow-runs.viewed',
      actorId,
      subject: { entityType: 'WorkflowRun', entityId: id },
      tenantId,
    });

    return this.toResult(run, liveStatus);
  }

  private toResult(
    run: WorkflowRunDocument,
    statusOverride?: WorkflowRunStatus,
  ): WorkflowRunResult {
    return {
      id: run._id.toString(),
      workflowId: run.workflowId,
      status: statusOverride ?? run.status,
      currentStep: run.currentStep,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt,
    };
  }
}
