import { ingestDocumentVersion } from '../../src/workflows/ingest-document-version.workflow';
import type { IngestDocumentVersionInput } from '../../src/workflows/types';

interface ActivityStubs {
  ingestDocumentVersion: jest.Mock;
  extractFacts: jest.Mock;
  scanForConflicts: jest.Mock;
  requestIngestApproval: jest.Mock;
  getApprovalDecision: jest.Mock;
}

interface ProxyActivitiesOptions {
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
    requestIngestApproval: jest.fn(),
    getApprovalDecision: jest.fn(),
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
// would see an empty array once the first spec's cleanup has run. Order matches the source file's
// declaration order: ingest, facts, conflicts, approval request, approval decision.
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

describe('proxyActivities retry configuration', () => {
  // Guards each group's `nonRetryableErrorTypes` against a silent rename of the error class it
  // names — Temporal matches these as plain strings (see the workflow file's own group comments),
  // so a rename that isn't mirrored here would disable the classification without failing tsc.
  it("should mark a missing tenantId, Voyage's deterministic failures, and a scanned PDF's missing text layer non-retryable for ingestDocumentVersion", () => {
    const [ingestOptions] = proxyActivitiesCalls[0];
    expect(ingestOptions.retry?.nonRetryableErrorTypes).toEqual([
      'MissingTenantId',
      'VoyageApiKeyMissingError',
      'VoyageInvalidResponseError',
      'EmptyPdfTextLayerException',
    ]);
  });

  it('should mark a missing tenantId, the budget, pricing, schema-validation, and spend-guard failures non-retryable for extractFacts', () => {
    const [factsOptions] = proxyActivitiesCalls[1];
    expect(factsOptions.retry?.nonRetryableErrorTypes).toEqual([
      'MissingTenantId',
      'ModelBudgetExceededError',
      'UnknownModelPricingError',
      'ModelSchemaValidationError',
      'TenantSpendLimitExceededError',
      'ModelRequestMissingTenantError',
    ]);
  });

  it('should mark a missing tenantId non-retryable for scanForConflicts', () => {
    const [conflictsOptions] = proxyActivitiesCalls[2];
    expect(conflictsOptions.retry?.nonRetryableErrorTypes).toEqual(['MissingTenantId']);
  });

  it('should mark a missing tenantId non-retryable for requestIngestApproval', () => {
    const [approvalRequestOptions] = proxyActivitiesCalls[3];
    expect(approvalRequestOptions.retry?.nonRetryableErrorTypes).toEqual(['MissingTenantId']);
  });

  it('should mark a missing tenantId non-retryable for getApprovalDecision', () => {
    const [approvalDecisionOptions] = proxyActivitiesCalls[4];
    expect(approvalDecisionOptions.retry?.nonRetryableErrorTypes).toEqual(['MissingTenantId']);
  });
});
