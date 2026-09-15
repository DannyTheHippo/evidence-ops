import { EXTRACT_FACTS_START_TO_CLOSE_TIMEOUT_MS } from '../../src/workflows/activity-heartbeat-policy';
import { ingestDocumentVersion } from '../../src/workflows/ingest-document-version.workflow';
import {
  EXTRACT_FACTS_NON_RETRYABLE_ERROR_TYPES,
  INGEST_HEARTBEAT_TIMEOUT_MS,
  INGEST_NON_RETRYABLE_ERROR_TYPES,
  INGEST_SCHEDULE_TO_CLOSE_TIMEOUT_MS,
  INGEST_START_TO_CLOSE_TIMEOUT_MS,
} from '../../src/workflows/ingest-retry-policy';
import type { IngestDocumentVersionInput } from '../../src/workflows/types';

interface ActivityStubs {
  ingestDocumentVersion: jest.Mock;
  extractFacts: jest.Mock;
  scanForConflicts: jest.Mock;
  recordFactExtractionFailure: jest.Mock;
  requestIngestApproval: jest.Mock;
  getApprovalDecision: jest.Mock;
  recordWorkflowRunEnd: jest.Mock;
}

interface ProxyActivitiesOptions {
  readonly startToCloseTimeout?: number | string;
  readonly scheduleToCloseTimeout?: number | string;
  readonly heartbeatTimeout?: number | string;
  readonly retry?: { readonly nonRetryableErrorTypes?: readonly string[] };
}

interface MockedTemporalWorkflow {
  activityStubs: ActivityStubs;
  proxyActivities: jest.Mock<unknown, [ProxyActivitiesOptions]>;
  setHandler: jest.Mock;
  condition: jest.Mock;
  workflowInfo: jest.Mock;
}

type SignalHandler = (payload?: { claimedDecision?: 'approved' | 'rejected' }) => void;

/**
 * Same mocking approach `resolve-conflict.workflow.spec.ts` uses, for the same reason (see that
 * file's own top-of-file comment): no `@temporalio/testing` package is installed, so the SDK
 * itself is mocked rather than actually run. `jest.mock` is hoisted above this file's own imports
 * (including the `ingestDocumentVersion` import above, whose module-level `proxyActivities`/
 * `defineSignal` calls run against this mock), so `activityStubs` is declared inside the factory.
 */
jest.mock('@temporalio/workflow', () => {
  const activityStubs = {
    ingestDocumentVersion: jest.fn(),
    extractFacts: jest.fn(),
    scanForConflicts: jest.fn(),
    recordFactExtractionFailure: jest.fn(),
    requestIngestApproval: jest.fn(),
    getApprovalDecision: jest.fn(),
    recordWorkflowRunEnd: jest.fn(),
  };
  return {
    activityStubs,
    proxyActivities: jest.fn(() => activityStubs),
    defineSignal: jest.fn((name: string) => ({ name })),
    setHandler: jest.fn(),
    condition: jest.fn(),
    workflowInfo: jest.fn(() => ({ workflowId: 'wf-ingest-1' })),
  };
});

const temporalWorkflowMock = jest.requireMock(
  '@temporalio/workflow',
) as unknown as MockedTemporalWorkflow;
const { activityStubs, setHandler, condition, workflowInfo } = temporalWorkflowMock;

// Captured once, right after the workflow module's own top-level `proxyActivities` calls run
// (during the `ingestDocumentVersion` import above) and before any `afterEach(jest.resetAllMocks)`
// wipes `proxyActivities.mock.calls` — a later `describe` block reading `.mock.calls` directly
// would see an empty array once the first spec's cleanup has run. Index 0 belongs to `run-
// recording.ts`'s own `runActivities` group (imported ahead of this file's own activity
// declarations); indexes 1-6 match the source file's declaration order: ingest, facts,
// facts-failure recording, conflicts, approval request, approval decision.
const proxyActivitiesCalls = [...temporalWorkflowMock.proxyActivities.mock.calls];

const ungatedInput: IngestDocumentVersionInput = {
  documentVersionId: 'version-1',
  tenantId: 'tenant-a',
};

const gatedInput: IngestDocumentVersionInput = {
  documentVersionId: 'version-1',
  requireApproval: true,
  documentTitle: 'Q3 Rent Roll',
  tenantId: 'acme-corp',
};

let capturedHandler: SignalHandler | undefined;

// Real `FactKey`-shaped values, not `[]` — `extractFacts`'s no-op branch loads and returns the
// existing facts' keys (see `FactsExtractionResult.factKeys`'s own doc comment), so a stub
// resolving `[]` here would hide the exact regression that field exists to prevent.
const extractedFactKeys = [
  { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
];

describe('ingestDocumentVersion', () => {
  beforeEach(() => {
    capturedHandler = undefined;
    setHandler.mockImplementation((_def: unknown, handler: SignalHandler) => {
      capturedHandler = handler;
    });
    activityStubs.ingestDocumentVersion.mockResolvedValue({
      chunksCreated: 4,
      alreadyIngested: false,
    });
    activityStubs.extractFacts.mockResolvedValue({
      factsCreated: 4,
      alreadyExtracted: false,
      skippedChunkCount: 0,
      factKeys: extractedFactKeys,
    });
    activityStubs.requestIngestApproval.mockResolvedValue({ id: 'approval-1' });
    // `resetAllMocks()` below wipes `jest.mock`'s factory-time implementation every test — must be
    // re-set here (`jest-tests.md`'s own convention for a `jest.fn` carrying an implementation).
    workflowInfo.mockReturnValue({ workflowId: 'wf-ingest-1' });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should run the pipeline without requesting approval when requireApproval is absent (default is do not gate)', async () => {
    const result = await ingestDocumentVersion(ungatedInput);

    expect(activityStubs.ingestDocumentVersion).toHaveBeenCalledWith('version-1', 'tenant-a');
    expect(activityStubs.extractFacts).toHaveBeenCalledWith('version-1', 'tenant-a');
    expect(activityStubs.scanForConflicts).toHaveBeenCalledWith('tenant-a', extractedFactKeys);
    expect(activityStubs.requestIngestApproval).not.toHaveBeenCalled();
    expect(setHandler).not.toHaveBeenCalled();
    expect(condition).not.toHaveBeenCalled();
    expect(result).toEqual({ chunksCreated: 4, alreadyIngested: false });
  });

  // An ingest that succeeded and a fact extraction that did not leaves the version `completed`
  // and searchable with no facts in it. Recording that state is what makes the two tellable
  // apart; the conflict scan is skipped because there are no new fact keys to scan.
  it('should record the fact-extraction failure and rethrow it, without scanning for conflicts', async () => {
    const extractionFailure = new Error('daily spend ceiling reached');
    activityStubs.extractFacts.mockRejectedValue(extractionFailure);

    await expect(ingestDocumentVersion(ungatedInput)).rejects.toBe(extractionFailure);

    expect(activityStubs.recordFactExtractionFailure).toHaveBeenCalledWith(
      'version-1',
      'tenant-a',
      'daily spend ceiling reached',
    );
    expect(activityStubs.scanForConflicts).not.toHaveBeenCalled();
  });

  it('should describe a non-Error extraction failure rather than dropping its detail', async () => {
    activityStubs.extractFacts.mockRejectedValue('extraction rejected with a bare string');

    await expect(ingestDocumentVersion(ungatedInput)).rejects.toBe(
      'extraction rejected with a bare string',
    );

    expect(activityStubs.recordFactExtractionFailure).toHaveBeenCalledWith(
      'version-1',
      'tenant-a',
      'extraction rejected with a bare string',
    );
  });

  // The recording is bookkeeping around the real failure: its own failure must never become the
  // one the workflow reports, or the cause is lost.
  it('should still fail with the extraction error when recording the failure itself fails', async () => {
    const extractionFailure = new Error('daily spend ceiling reached');
    activityStubs.extractFacts.mockRejectedValue(extractionFailure);
    activityStubs.recordFactExtractionFailure.mockRejectedValue(new Error('mongo unreachable'));

    await expect(ingestDocumentVersion(ungatedInput)).rejects.toBe(extractionFailure);
  });

  it('should run the pipeline and record an approved gate outcome when a signal wakes it and the persisted decision is approved', async () => {
    condition.mockImplementation((predicate: () => boolean) => {
      // Simulates a signal arriving mid-wait — the real handler this workflow registered via
      // `setHandler`, exactly as `resolve-conflict.workflow.spec.ts` does for its own wait.
      capturedHandler?.();
      return predicate();
    });
    activityStubs.getApprovalDecision.mockResolvedValue({
      decision: 'approved',
      decidedBy: 'reviewer@example.com',
    });

    const result = await ingestDocumentVersion(gatedInput);

    expect(activityStubs.requestIngestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ingest_document_version',
        summary: "Approve ingesting 'Q3 Rent Roll' (version 'version-1')",
        subject: { entityType: 'DocumentVersion', entityId: 'version-1' },
        tenantId: 'acme-corp',
        workflowId: 'wf-ingest-1',
      }),
    );
    expect(activityStubs.getApprovalDecision).toHaveBeenCalledWith('approval-1', 'acme-corp');
    expect(activityStubs.ingestDocumentVersion).toHaveBeenCalledWith('version-1', 'acme-corp');
    expect(activityStubs.extractFacts).toHaveBeenCalledWith('version-1', 'acme-corp');
    expect(activityStubs.scanForConflicts).toHaveBeenCalledWith('acme-corp', extractedFactKeys);
    expect(result).toEqual({ chunksCreated: 4, alreadyIngested: false, gateOutcome: 'approved' });
  });

  it('should never run the pipeline and record a rejected gate outcome when the persisted decision is rejected', async () => {
    condition.mockImplementation((predicate: () => boolean) => {
      capturedHandler?.();
      return predicate();
    });
    activityStubs.getApprovalDecision.mockResolvedValue({ decision: 'rejected' });

    const result = await ingestDocumentVersion(gatedInput);

    expect(activityStubs.ingestDocumentVersion).not.toHaveBeenCalled();
    expect(activityStubs.extractFacts).not.toHaveBeenCalled();
    expect(activityStubs.scanForConflicts).not.toHaveBeenCalled();
    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: false, gateOutcome: 'rejected' });
  });

  it('should never run the pipeline and record a timed_out gate outcome, without reading the decision, when condition times out', async () => {
    condition.mockResolvedValue(false);

    const result = await ingestDocumentVersion(gatedInput);

    expect(activityStubs.getApprovalDecision).not.toHaveBeenCalled();
    expect(activityStubs.ingestDocumentVersion).not.toHaveBeenCalled();
    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: false, gateOutcome: 'timed_out' });
  });

  it('should ignore a signal payload that claims approval and still record rejected when the persisted row disagrees', async () => {
    condition.mockImplementation((predicate: () => boolean) => {
      // The payload claims approval — the workflow must never read it (see
      // `ingestApprovalDecisionSignal`'s doc comment); only `getApprovalDecision`'s
      // mocked-rejected response below should decide the outcome.
      capturedHandler?.({ claimedDecision: 'approved' });
      return predicate();
    });
    activityStubs.getApprovalDecision.mockResolvedValue({ decision: 'rejected' });

    const result = await ingestDocumentVersion(gatedInput);

    expect(activityStubs.ingestDocumentVersion).not.toHaveBeenCalled();
    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: false, gateOutcome: 'rejected' });
  });

  it('should fall back to a bare documentVersionId summary when documentTitle is absent', async () => {
    condition.mockImplementation((predicate: () => boolean) => {
      capturedHandler?.();
      return predicate();
    });
    activityStubs.getApprovalDecision.mockResolvedValue({ decision: 'approved' });

    await ingestDocumentVersion({
      documentVersionId: 'version-2',
      requireApproval: true,
      tenantId: 'tenant-a',
    });

    expect(activityStubs.requestIngestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Approve ingesting document version 'version-2'",
      }),
    );
  });
});

describe('ingestDocumentVersion run recording', () => {
  beforeEach(() => {
    capturedHandler = undefined;
    setHandler.mockImplementation((_def: unknown, handler: SignalHandler) => {
      capturedHandler = handler;
    });
    activityStubs.ingestDocumentVersion.mockResolvedValue({
      chunksCreated: 4,
      alreadyIngested: false,
    });
    activityStubs.extractFacts.mockResolvedValue({
      factsCreated: 4,
      alreadyExtracted: false,
      skippedChunkCount: 0,
      factKeys: extractedFactKeys,
    });
    activityStubs.requestIngestApproval.mockResolvedValue({ id: 'approval-1' });
    workflowInfo.mockReturnValue({ workflowId: 'wf-ingest-1' });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // A gate's `rejected`/`timed_out` verdict lives on `IngestDocumentVersionResult.gateOutcome`
  // and the `Approval` row, never on the run's `outcome` field — see `runIngestDocumentVersion`'s
  // own doc comment. Every ordinary ending, gated or not, records `completed` with no `outcome`.
  it('should record the run completed with no outcome on an ungated upload', async () => {
    await ingestDocumentVersion(ungatedInput);

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-ingest-1',
      status: 'completed',
      outcome: undefined,
    });
  });

  it('should record the run completed with no outcome when a gate rejects the ingest', async () => {
    condition.mockImplementation((predicate: () => boolean) => {
      capturedHandler?.();
      return predicate();
    });
    activityStubs.getApprovalDecision.mockResolvedValue({ decision: 'rejected' });

    await ingestDocumentVersion(gatedInput);

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-ingest-1',
      status: 'completed',
      outcome: undefined,
    });
  });

  it('should record the run completed with no outcome when a gate times out', async () => {
    condition.mockResolvedValue(false);

    await ingestDocumentVersion(gatedInput);

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-ingest-1',
      status: 'completed',
      outcome: undefined,
    });
  });

  it('should record the run failed with the error message and rethrow when the pipeline throws', async () => {
    const extractionFailure = new Error('daily spend ceiling reached');
    activityStubs.extractFacts.mockRejectedValue(extractionFailure);
    activityStubs.recordFactExtractionFailure.mockResolvedValue(undefined);

    await expect(ingestDocumentVersion(ungatedInput)).rejects.toBe(extractionFailure);

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-ingest-1',
      status: 'failed',
      errorMessage: 'daily spend ceiling reached',
    });
  });
});

describe('proxyActivities retry configuration', () => {
  // Guards each group's `nonRetryableErrorTypes` against a silent rename of the error class it
  // names — Temporal matches these as plain strings (see the workflow file's own group comments),
  // so a rename that isn't mirrored here would disable the classification without failing tsc.
  it('should apply the declared non-retryable classification to ingestDocumentVersion', () => {
    const [ingestOptions] = proxyActivitiesCalls[1];
    expect(ingestOptions.retry?.nonRetryableErrorTypes).toEqual([
      ...INGEST_NON_RETRYABLE_ERROR_TYPES,
    ]);
  });

  // A heartbeat with no timeout declared is inert — Temporal never fails a stalled attempt and
  // never delivers cancellation back to it, so `IngestionService`'s catch never records the
  // failure. The pairing is asserted here because nothing in the type system requires it.
  it('should declare a heartbeat timeout for ingestDocumentVersion, under its startToCloseTimeout', () => {
    const [ingestOptions] = proxyActivitiesCalls[1];
    expect(ingestOptions.heartbeatTimeout).toBe(INGEST_HEARTBEAT_TIMEOUT_MS);
    expect(ingestOptions.startToCloseTimeout).toBe(INGEST_START_TO_CLOSE_TIMEOUT_MS);
    expect(ingestOptions.scheduleToCloseTimeout).toBe(INGEST_SCHEDULE_TO_CLOSE_TIMEOUT_MS);
  });

  it('should apply the declared non-retryable classification to extractFacts', () => {
    const [factsOptions] = proxyActivitiesCalls[2];
    expect(factsOptions.retry?.nonRetryableErrorTypes).toEqual([
      ...EXTRACT_FACTS_NON_RETRYABLE_ERROR_TYPES,
    ]);
  });

  it('should declare a heartbeat timeout for extractFacts, under its startToCloseTimeout', () => {
    const [factsOptions] = proxyActivitiesCalls[2];
    expect(factsOptions.heartbeatTimeout).toBe(INGEST_HEARTBEAT_TIMEOUT_MS);
    expect(factsOptions.startToCloseTimeout).toBe(EXTRACT_FACTS_START_TO_CLOSE_TIMEOUT_MS);
  });

  // The property every group in this file must hold, not just the two named above: a numeric
  // `startToCloseTimeout` strictly greater than `INGEST_HEARTBEAT_TIMEOUT_MS` must declare a
  // `heartbeatTimeout`, and a group that still expresses its budget as a Temporal duration string
  // must keep that budget at or under the heartbeat timeout — the shape every cheap, pure-Mongo
  // group in the workflow file uses.
  it('should keep every captured proxyActivities group consistent with the heartbeat-timeout property', () => {
    const durationPattern = /^(\d+) (seconds?|minutes?)$/;
    for (const [options] of proxyActivitiesCalls) {
      const { startToCloseTimeout, heartbeatTimeout } = options;
      if (typeof startToCloseTimeout === 'number') {
        if (startToCloseTimeout > INGEST_HEARTBEAT_TIMEOUT_MS) {
          expect(heartbeatTimeout).toBeDefined();
        }
        continue;
      }
      const match = durationPattern.exec(startToCloseTimeout ?? '');
      expect(match).not.toBeNull();
      const [, amount, unit] = match as RegExpExecArray;
      const ms = Number(amount) * (unit.startsWith('minute') ? 60_000 : 1_000);
      expect(ms).toBeLessThanOrEqual(INGEST_HEARTBEAT_TIMEOUT_MS);
    }
  });

  it('should mark a missing tenantId and an unknown version non-retryable for recordFactExtractionFailure', () => {
    const [factsFailureOptions] = proxyActivitiesCalls[3];
    expect(factsFailureOptions.retry?.nonRetryableErrorTypes).toEqual([
      'MissingTenantId',
      'DocumentVersionNotFoundException',
    ]);
  });

  it('should mark a missing tenantId non-retryable for scanForConflicts', () => {
    const [conflictsOptions] = proxyActivitiesCalls[4];
    expect(conflictsOptions.retry?.nonRetryableErrorTypes).toEqual(['MissingTenantId']);
  });

  it('should mark a missing tenantId non-retryable for requestIngestApproval', () => {
    const [approvalRequestOptions] = proxyActivitiesCalls[5];
    expect(approvalRequestOptions.retry?.nonRetryableErrorTypes).toEqual(['MissingTenantId']);
  });

  it('should mark a missing tenantId non-retryable for getApprovalDecision', () => {
    const [approvalDecisionOptions] = proxyActivitiesCalls[6];
    expect(approvalDecisionOptions.retry?.nonRetryableErrorTypes).toEqual(['MissingTenantId']);
  });
});
