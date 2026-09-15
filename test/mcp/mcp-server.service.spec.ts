import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HttpStatus } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TypedConfigService } from '../../src/config/environment/typed-config.service';
import { AttestationService } from '../../src/features/evidence/attestations/attestation.service';
import { AttestationSubjectRequiredException } from '../../src/features/evidence/attestations/exceptions/attestations.exception';
import { ClaimVerificationService } from '../../src/features/evidence/qa/claim-verification.service';
import { ConflictsService } from '../../src/features/evidence/conflicts/conflicts.service';
import { unparseablePeriodKey } from '../../src/features/evidence/facts/derive-period';
import { LedgerService } from '../../src/features/evidence/ledger/ledger.service';
import { EvidenceRetrievalService } from '../../src/features/evidence/qa/evidence-retrieval.service';
import { QaService } from '../../src/features/evidence/qa/qa.service';
import {
  SEARCH_EVIDENCE_TOOL_NAME,
  searchEvidenceToolDefinition,
} from '../../src/features/evidence/retrieval/evidence-tools';
import { UnsupportedContentTypeException } from '../../src/features/evidence/documents/exceptions/documents.exception';
import {
  EvidenceSubmissionService,
  SUBMIT_EVIDENCE_MAX_BASE64_CHARS,
} from '../../src/features/evidence/sources/evidence-submission.service';
import { InvalidBase64ContentException } from '../../src/features/evidence/sources/exceptions/sources.exception';
import {
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '../../src/features/platform/api-keys/token-verifier.interface';
import { TOOL_AUTHZ_HOOK } from '../../src/features/platform/authz/authz-hook.interface';
import { StepPolicyAuthzHook } from '../../src/features/platform/authz/step-policy.authz-hook';
import { ToolExecutorService } from '../../src/features/platform/authz/tool-executor.service';
import type { ToolExecutionStep } from '../../src/features/platform/authz/types/tool-definition.type';
import { AnswerNotFoundException } from '../../src/features/evidence/qa/exceptions/qa.exception';
import { McpServerService } from '../../src/mcp/mcp-server.service';
import { BaseException } from '../../src/shared/exceptions/base.exception';
import {
  ASK_EVIDENCE_QUESTION_MAX_LENGTH,
  ASK_EVIDENCE_TOOL_NAME,
  ATTESTATION_ID_MAX_LENGTH,
  GET_ANSWER_TOOL_NAME,
  GET_ATTESTATION_TOOL_NAME,
  LOOKUP_FACT_PERIOD_MAX_LENGTH,
  LOOKUP_FACT_TOOL_NAME,
  MCP_ASK_STEP,
  MCP_MUTATE_STEP,
  MCP_READ_STEP,
  MCP_SUBMIT_STEP,
  MCP_VERIFY_STEP,
  REQUEST_RESOLUTION_TOOL_NAME,
  SUBMIT_EVIDENCE_TOOL_NAME,
  VERIFY_CLAIMS_CLAIM_MAX_LENGTH,
  VERIFY_CLAIMS_MAX_CLAIMS,
  VERIFY_CLAIMS_TOOL_NAME,
} from '../../src/mcp/mcp-tools';
import { PatTokenVerifier } from '../../src/mcp/pat-token.verifier';
import {
  MCP_RATE_LIMIT_SWEEP_BATCH_SIZE,
  MCP_TOOL_CALL_EXECUTED_ACTION,
  MCP_TOOL_CALL_FAILED_ACTION,
  MCP_TOOL_CALL_REFUSED_ACTION,
} from '../../src/mcp/mcp.constant';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { AuditService } from '../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../src/shared/services/logger/logger.service';
import type { AlsContext } from '../../src/shared/types/als-context.type';
import type { MockLogger } from '../utils/get-mock-logger';
import { getMockLogger } from '../utils/get-mock-logger';
import { getMockTypedConfig } from '../utils/get-mock-typed-config';

const TENANT_A_TOKEN = 'eo_pat_tenant-a-token';
const TENANT_A_IDENTITY = { userId: 'actor-a', tenantId: 'tenant-a', role: UserRole.Member };
const TENANT_A_CONTEXT = { actorId: 'actor-a', tenantId: 'tenant-a', role: UserRole.Member };
const TENANT_A_ADMIN_CONTEXT = { actorId: 'admin-a', tenantId: 'tenant-a', role: UserRole.Admin };

function buildRunResult() {
  return {
    id: 'run-1',
    workflowId: 'workflow-1',
    // Non-terminal — the run is still parked on the durable human approval `resolveConflict`
    // (`resolve-conflict.workflow.ts`) starts, never resolved by this call.
    status: 'running' as const,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function buildChunk() {
  return {
    chunkId: 'chunk-1',
    docVersionId: 'version-1',
    sha256: 'a'.repeat(64),
    text: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
    locator: { kind: 'pdf-page' as const, page: 3, extractorVersion: 'v1' },
  };
}

function buildStartQuestionResult() {
  return { id: 'answer-2', runStatus: 'queued' as const };
}

function buildVerifyClaimsResult() {
  return {
    advisory: 'A "grounded" verdict means an independent verifier located supporting evidence.',
    results: [{ claimIndex: 0, verdict: 'grounded' as const }],
  };
}

function buildSubmitEvidenceResult() {
  return {
    documentId: 'document-1',
    documentVersionId: 'version-1',
    sha256: 'a'.repeat(64),
    ingestionStatus: 'queued' as const,
    isNewVersion: true,
    sourceId: 'source-1',
  };
}

function buildLedgerResolution() {
  return {
    entity: 'Northgate Business Park',
    measure: 'cap_rate',
    period: '2026-Q1',
    state: 'single' as const,
    value: { amount: 6.1, unit: 'percent' },
    factIds: ['fact-1'],
    citations: [
      {
        factId: 'fact-1',
        documentId: 'document-1',
        documentVersionId: 'version-1',
        sha256: 'a'.repeat(64),
        locator: { kind: 'pdf-page' as const, page: 3, extractorVersion: 'v1' },
        extractorVersion: 'v1',
        quote: 'traded at a cap rate of approximately 6.10%',
        withdrawn: false,
      },
    ],
  };
}

function buildAttestationBundle() {
  return {
    schemaVersion: 1 as const,
    kind: 'answer' as const,
    subjectId: 'answer-1',
    tenantId: 'tenant-a',
    producedAt: '2026-01-01T00:00:00.000Z',
    subject: { question: 'What was the cap rate?' },
    outcome: 'answered' as const,
    claims: [],
    decisions: [],
    measures: [],
    integrity: { algorithm: 'sha256' as const, contentHash: 'b'.repeat(64) },
  };
}

function buildAnswerEnvelope() {
  return {
    id: 'answer-1',
    questionText: 'What was the cap rate?',
    runStatus: 'completed' as const,
    outcome: {
      kind: 'answered' as const,
      claims: [
        {
          statement: 'The cap rate was approximately 6.10%.',
          citations: [
            {
              docVersionId: 'version-1',
              sha256: 'a'.repeat(64),
              chunkId: 'chunk-1',
              locator: { kind: 'pdf-page' as const, page: 3, extractorVersion: 'v1' },
              quote: 'traded at a cap rate of approximately 6.10%',
            },
          ],
        },
      ],
    },
    claimCoverage: 1,
    citations: [
      {
        docVersionId: 'version-1',
        sha256: 'a'.repeat(64),
        chunkId: 'chunk-1',
        locator: { kind: 'pdf-page' as const, page: 3, extractorVersion: 'v1' },
        quote: 'traded at a cap rate of approximately 6.10%',
      },
    ],
    conflictIds: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

interface Harness {
  readonly service: McpServerService;
  readonly toolExecutor: ToolExecutorService;
  readonly tokenVerifier: jest.Mocked<TokenVerifier>;
  readonly evidenceRetrievalService: { retrieve: jest.Mock };
  readonly qaService: { getAnswerById: jest.Mock; startQuestion: jest.Mock };
  readonly conflictsService: { requestResolution: jest.Mock };
  readonly claimVerificationService: { verifyClaims: jest.Mock };
  readonly evidenceSubmissionService: { submit: jest.Mock };
  readonly ledgerService: { resolveValue: jest.Mock };
  readonly attestationService: { exportForAnswer: jest.Mock; exportForVerification: jest.Mock };
  readonly auditService: { record: jest.Mock };
  readonly als: AsyncLocalStorage<AlsContext>;
  readonly logger: MockLogger;
}

async function buildHarness(
  rateLimitPerMinute = 60,
  preAuthIpRateLimitMaxRequests = 20,
  preAuthIpRateLimitWindowMs = 60000,
  dailyLimitUsd = 50,
): Promise<Harness> {
  const tokenVerifier: jest.Mocked<TokenVerifier> = { verify: jest.fn() };
  const evidenceRetrievalService = { retrieve: jest.fn().mockResolvedValue([buildChunk()]) };
  const qaService = {
    getAnswerById: jest.fn().mockResolvedValue(buildAnswerEnvelope()),
    startQuestion: jest.fn().mockResolvedValue(buildStartQuestionResult()),
  };
  const conflictsService = { requestResolution: jest.fn().mockResolvedValue(buildRunResult()) };
  const claimVerificationService = {
    verifyClaims: jest.fn().mockResolvedValue(buildVerifyClaimsResult()),
  };
  const evidenceSubmissionService = {
    submit: jest.fn().mockResolvedValue(buildSubmitEvidenceResult()),
  };
  const ledgerService = { resolveValue: jest.fn().mockResolvedValue(buildLedgerResolution()) };
  const attestationService = {
    exportForAnswer: jest.fn().mockResolvedValue(buildAttestationBundle()),
    exportForVerification: jest.fn().mockResolvedValue(buildAttestationBundle()),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  const als = new AsyncLocalStorage<AlsContext>();
  const logger = getMockLogger();
  const config = getMockTypedConfig({
    mcp: {
      port: 3002,
      rateLimitPerMinute,
      preAuthIpRateLimitWindowMs,
      preAuthIpRateLimitMaxRequests,
    },
    spend: { dailyLimitUsd, ingestDailyLimitUsd: undefined },
  });

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ToolExecutorService,
      { provide: TOOL_AUTHZ_HOOK, useClass: StepPolicyAuthzHook },
      PatTokenVerifier,
      { provide: TOKEN_VERIFIER, useValue: tokenVerifier },
      { provide: AsyncLocalStorage, useValue: als },
      { provide: TypedConfigService, useValue: config },
      { provide: AppLogger, useValue: logger },
      { provide: EvidenceRetrievalService, useValue: evidenceRetrievalService },
      { provide: QaService, useValue: qaService },
      { provide: ConflictsService, useValue: conflictsService },
      { provide: ClaimVerificationService, useValue: claimVerificationService },
      { provide: EvidenceSubmissionService, useValue: evidenceSubmissionService },
      { provide: LedgerService, useValue: ledgerService },
      { provide: AttestationService, useValue: attestationService },
      { provide: AuditService, useValue: auditService },
      McpServerService,
    ],
  }).compile();

  return {
    service: module.get(McpServerService),
    toolExecutor: module.get(ToolExecutorService),
    tokenVerifier,
    evidenceRetrievalService,
    qaService,
    conflictsService,
    claimVerificationService,
    evidenceSubmissionService,
    ledgerService,
    attestationService,
    auditService,
    als,
    logger,
  };
}

/** Connects a real SDK `Client` to the `Server` under test over
 *  `InMemoryTransport.createLinkedPair()` — no sockets, so it runs unmodified in this sandbox. */
async function connectClient(server: ReturnType<McpServerService['buildServer']>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('McpServerService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('tools/list', () => {
    it('should advertise all eight tools, with strict, object-rooted schemas', async () => {
      const { service } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          SEARCH_EVIDENCE_TOOL_NAME,
          GET_ANSWER_TOOL_NAME,
          REQUEST_RESOLUTION_TOOL_NAME,
          ASK_EVIDENCE_TOOL_NAME,
          VERIFY_CLAIMS_TOOL_NAME,
          SUBMIT_EVIDENCE_TOOL_NAME,
          LOOKUP_FACT_TOOL_NAME,
          GET_ATTESTATION_TOOL_NAME,
        ].sort(),
      );

      // Cast, not `expect.any(Object)` inside the object literal below — its `any`-typed return
      // trips `no-unsafe-assignment`, same reasoning `documents.service.spec.ts` documents for its
      // own identical case.
      const searchEvidence = tools.find((tool) => tool.name === SEARCH_EVIDENCE_TOOL_NAME);
      const searchEvidenceSchema = searchEvidence?.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
      };
      expect(searchEvidenceSchema.type).toBe('object');
      expect(Object.keys(searchEvidenceSchema.properties ?? {})).toEqual(['query']);

      const getAnswer = tools.find((tool) => tool.name === GET_ANSWER_TOOL_NAME);
      const getAnswerSchema = getAnswer?.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(getAnswerSchema).toMatchObject({
        type: 'object',
        required: ['answerId'],
        // Advertised strictness matches what `ToolExecutorService.registerTool` actually
        // enforces (`applyStrictRecursively`) — see `mcp-tools.ts`'s doc comment on why this
        // schema, unlike its `evidence-tools.ts` sibling, calls `.strict()`.
        additionalProperties: false,
      });
      expect(Object.keys(getAnswerSchema.properties ?? {})).toEqual(['answerId']);

      const requestResolution = tools.find((tool) => tool.name === REQUEST_RESOLUTION_TOOL_NAME);
      const requestResolutionSchema = requestResolution?.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(requestResolutionSchema).toMatchObject({
        type: 'object',
        required: ['conflictId', 'winningFactId'],
        additionalProperties: false,
      });
      expect(Object.keys(requestResolutionSchema.properties ?? {}).sort()).toEqual(
        ['conflictId', 'winningFactId'].sort(),
      );

      const askEvidence = tools.find((tool) => tool.name === ASK_EVIDENCE_TOOL_NAME);
      const askEvidenceSchema = askEvidence?.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(askEvidenceSchema).toMatchObject({
        type: 'object',
        required: ['question'],
        additionalProperties: false,
      });
      expect(Object.keys(askEvidenceSchema.properties ?? {})).toEqual(['question']);

      const verifyClaims = tools.find((tool) => tool.name === VERIFY_CLAIMS_TOOL_NAME);
      const verifyClaimsSchema = verifyClaims?.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(verifyClaimsSchema).toMatchObject({
        type: 'object',
        required: ['claims'],
        additionalProperties: false,
      });
      expect(Object.keys(verifyClaimsSchema.properties ?? {})).toEqual(['claims']);

      const submitEvidence = tools.find((tool) => tool.name === SUBMIT_EVIDENCE_TOOL_NAME);
      const submitEvidenceSchema = submitEvidence?.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(submitEvidenceSchema).toMatchObject({
        type: 'object',
        required: ['filename', 'mimeType', 'contentBase64'],
        additionalProperties: false,
      });
      expect(Object.keys(submitEvidenceSchema.properties ?? {}).sort()).toEqual(
        ['filename', 'mimeType', 'contentBase64', 'sourceLabel'].sort(),
      );

      const lookupFact = tools.find((tool) => tool.name === LOOKUP_FACT_TOOL_NAME);
      const lookupFactSchema = lookupFact?.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(lookupFactSchema).toMatchObject({
        type: 'object',
        required: ['entity', 'measure'],
        additionalProperties: false,
      });
      expect(Object.keys(lookupFactSchema.properties ?? {}).sort()).toEqual(
        ['entity', 'measure', 'period'].sort(),
      );

      const getAttestation = tools.find((tool) => tool.name === GET_ATTESTATION_TOOL_NAME);
      const getAttestationSchema = getAttestation?.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(getAttestationSchema).toMatchObject({
        type: 'object',
        // Neither argument is individually required — exactly-one is enforced in the handler, not
        // the schema (`ToolExecutorService`'s `applyStrictRecursively` does not cover `ZodUnion` or
        // refinements — see `buildGetAttestationTool`'s own doc comment).
        additionalProperties: false,
      });
      expect(getAttestationSchema.required ?? []).toEqual([]);
      expect(Object.keys(getAttestationSchema.properties ?? {}).sort()).toEqual(
        ['answerId', 'verificationId'].sort(),
      );
    });

    // ADR-0014's whole point for this surface: the tool that *proposes* a conflict resolution
    // must never share a process with a tool that could *decide* one — ADR-0009's two-key control
    // only holds if no approval-deciding tool ever exists here, not merely that none is
    // advertised. `tools/call` routes any name through the step allowlists below regardless of
    // what `tools/list` shows, so the reachable set — not just the advertised one — is what this
    // asserts against, over both `MCP_READ_STEP` and `MCP_MUTATE_STEP`.
    //
    // The assertion is the exact, frozen contents of each allowlist, not a name-pattern exclusion
    // — a pattern only catches an addition whose name happens to contain "approv"/"decid"/"reject";
    // a future `finalize_resolution`, `settle_conflict`, or `commit_outcome` would sail through a
    // pattern check untouched. Pinning the arrays instead means *any* addition to either step
    // breaks this test by construction, forcing a human to consciously re-examine and update it.
    it('should expose exactly the frozen tool set on each MCP step, with no approval-deciding tool on any of them', async () => {
      const { service } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          SEARCH_EVIDENCE_TOOL_NAME,
          GET_ANSWER_TOOL_NAME,
          REQUEST_RESOLUTION_TOOL_NAME,
          ASK_EVIDENCE_TOOL_NAME,
          VERIFY_CLAIMS_TOOL_NAME,
          SUBMIT_EVIDENCE_TOOL_NAME,
          LOOKUP_FACT_TOOL_NAME,
          GET_ATTESTATION_TOOL_NAME,
        ].sort(),
      );
      expect(MCP_READ_STEP.allowedTools).toEqual([
        SEARCH_EVIDENCE_TOOL_NAME,
        GET_ANSWER_TOOL_NAME,
        LOOKUP_FACT_TOOL_NAME,
        GET_ATTESTATION_TOOL_NAME,
      ]);
      expect(MCP_MUTATE_STEP.allowedTools).toEqual([REQUEST_RESOLUTION_TOOL_NAME]);
      expect(MCP_ASK_STEP.allowedTools).toEqual([ASK_EVIDENCE_TOOL_NAME]);
      expect(MCP_VERIFY_STEP.allowedTools).toEqual([VERIFY_CLAIMS_TOOL_NAME]);
      expect(MCP_SUBMIT_STEP.allowedTools).toEqual([SUBMIT_EVIDENCE_TOOL_NAME]);
    });

    // A tool description is the only instruction an MCP client gets about what a call returns, and
    // this surface's `search_evidence` returns something different from the shared base
    // definition's own description: full chunk text rather than a short snippet — hence
    // `mcpSearchEvidenceToolDefinition` overriding `description` while reusing everything else.
    it('should advertise a search_evidence description that returns full chunk text', async () => {
      const { service } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const { tools } = await client.listTools();

      const searchEvidence = tools.find((tool) => tool.name === SEARCH_EVIDENCE_TOOL_NAME);
      expect(searchEvidence?.description).toContain('in full');
      expect(searchEvidenceToolDefinition.description).not.toContain('in full');
    });
  });

  describe('tools/call — search_evidence', () => {
    it('should execute using the tenant derived from the verified token, not any tool argument', async () => {
      const { service, evidenceRetrievalService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: SEARCH_EVIDENCE_TOOL_NAME,
        arguments: { query: 'cap rate' },
      });

      expect(result.isError).toBeUndefined();
      expect(evidenceRetrievalService.retrieve).toHaveBeenCalledWith({
        questionText: 'cap rate',
        tenantId: 'tenant-a',
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual([buildChunk()]);
    });

    it('should refuse a call carrying a tenantId argument rather than let it reach the handler', async () => {
      const { service, evidenceRetrievalService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: SEARCH_EVIDENCE_TOOL_NAME,
        arguments: { query: 'cap rate', tenantId: 'tenant-evil' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(evidenceRetrievalService.retrieve).not.toHaveBeenCalled();
    });

    // `origin: 'mcp'` in the store is what labels the rows the *shared* services write during a
    // tool call (`qa.answer.viewed`, `conflicts.resolution_requested`) as MCP-originated — those
    // methods take no origin argument, so without this an AI client's read is indistinguishable
    // from a person opening the page.
    it('should establish an ALS scope carrying the verified actor, tenant, and mcp origin for the call', async () => {
      const { service, evidenceRetrievalService, als } = await buildHarness();
      let observedStore: AlsContext | undefined;
      evidenceRetrievalService.retrieve.mockImplementation(() => {
        observedStore = als.getStore();
        return Promise.resolve([buildChunk()]);
      });
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      await client.callTool({ name: SEARCH_EVIDENCE_TOOL_NAME, arguments: { query: 'cap rate' } });

      expect(observedStore).toMatchObject({
        user: 'actor-a',
        tenant: 'tenant-a',
        origin: 'mcp',
      });
      expect(observedStore?.['correlation-id']).toEqual(expect.any(String));
    });

    it('should refuse an unregistered tool name', async () => {
      const { service } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({ name: 'delete_everything', arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('tool-not-registered');
    });

    it('should treat a call with no arguments field as an empty args object, not throw', async () => {
      const { service } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({ name: SEARCH_EVIDENCE_TOOL_NAME });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
    });
  });

  describe('tools/call — get_answer', () => {
    it('should fetch the answer using the actor/tenant derived from the token, returning citations verbatim with their locators', async () => {
      const { service, qaService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: GET_ANSWER_TOOL_NAME,
        arguments: { answerId: 'answer-1' },
      });

      expect(result.isError).toBeUndefined();
      expect(qaService.getAnswerById).toHaveBeenCalledWith('answer-1', 'actor-a', 'tenant-a');
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as ReturnType<typeof buildAnswerEnvelope>;
      expect(parsed.citations).toEqual(buildAnswerEnvelope().citations);
    });
  });

  describe('tools/call — request_resolution', () => {
    it('should delegate to ConflictsService.requestResolution using the tenant/actor derived from the token, and return only a run reference', async () => {
      const { service, conflictsService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_ADMIN_CONTEXT));

      const result = await client.callTool({
        name: REQUEST_RESOLUTION_TOOL_NAME,
        arguments: { conflictId: 'conflict-1', winningFactId: 'fact-1' },
      });

      expect(result.isError).toBeUndefined();
      // Same method `ConflictsController.requestResolution` calls — this asserts the MCP handler
      // delegates rather than re-implementing conflict loading or workflow starting itself.
      // `origin: 'mcp'` is what lets the human reading the approval inbox tell an AI client's
      // proposal from a colleague's — the second key only means something if the reviewer knows
      // what the first key was. `requestedBy` falls back to the actor id when the verified
      // identity carries no email.
      expect(conflictsService.requestResolution).toHaveBeenCalledWith({
        conflictId: 'conflict-1',
        winningFactId: 'fact-1',
        actorId: 'admin-a',
        requestedBy: 'admin-a',
        tenantId: 'tenant-a',
        origin: 'mcp',
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as ReturnType<typeof buildRunResult>;
      // Only a run reference comes back — `status: 'running'`, never a resolved/decided outcome
      // field, since the workflow this call started has only just parked on human approval.
      expect(parsed).toEqual({
        id: 'run-1',
        workflowId: 'workflow-1',
        status: 'running',
        createdAt: buildRunResult().createdAt.toISOString(),
      });
      expect(parsed).not.toHaveProperty('outcome');
      expect(parsed).not.toHaveProperty('decision');
    });

    it("should refuse a caller below mcp-mutate's Admin minimum, without starting any workflow", async () => {
      const { service, conflictsService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: REQUEST_RESOLUTION_TOOL_NAME,
        arguments: { conflictId: 'conflict-1', winningFactId: 'fact-1' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('authz-denied');
      expect(content[0].text).toContain("does not meet the minimum role 'admin'");
      expect(conflictsService.requestResolution).not.toHaveBeenCalled();
    });

    it('should refuse a call missing a required argument before reaching the service', async () => {
      const { service, conflictsService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_ADMIN_CONTEXT));

      const result = await client.callTool({
        name: REQUEST_RESOLUTION_TOOL_NAME,
        arguments: { conflictId: 'conflict-1' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(conflictsService.requestResolution).not.toHaveBeenCalled();
    });

    it('should refuse a call carrying a tenantId argument rather than let it reach the handler', async () => {
      const { service, conflictsService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_ADMIN_CONTEXT));

      const result = await client.callTool({
        name: REQUEST_RESOLUTION_TOOL_NAME,
        arguments: { conflictId: 'conflict-1', winningFactId: 'fact-1', tenantId: 'tenant-evil' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(conflictsService.requestResolution).not.toHaveBeenCalled();
    });
  });

  describe('tools/call — ask_evidence', () => {
    it('should start a question and return a handle, using the tenant/actor/role derived from the token, not any tool argument', async () => {
      const { service, qaService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: ASK_EVIDENCE_TOOL_NAME,
        arguments: { question: 'What was the cap rate?' },
      });

      expect(result.isError).toBeUndefined();
      expect(qaService.startQuestion).toHaveBeenCalledWith({
        questionText: 'What was the cap rate?',
        actorId: 'actor-a',
        role: UserRole.Member,
        tenantId: 'tenant-a',
      });
      const content = result.content as Array<{ type: string; text: string }>;
      // `StartQuestionResult.id` renamed to `answerId` on the wire — see `buildAskEvidenceTool`'s
      // doc comment for why, and `get_answer`'s `answerId` argument for the name it matches.
      expect(JSON.parse(content[0].text)).toEqual({
        answerId: buildStartQuestionResult().id,
        runStatus: buildStartQuestionResult().runStatus,
      });
    });

    it('should refuse a question over ASK_EVIDENCE_QUESTION_MAX_LENGTH at the schema chokepoint, never starting a workflow', async () => {
      const { service, qaService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: ASK_EVIDENCE_TOOL_NAME,
        arguments: { question: 'a'.repeat(ASK_EVIDENCE_QUESTION_MAX_LENGTH + 1) },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(qaService.startQuestion).not.toHaveBeenCalled();
    });

    it('should refuse an unknown extra argument key rather than silently stripping it', async () => {
      const { service, qaService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: ASK_EVIDENCE_TOOL_NAME,
        arguments: { question: 'What was the cap rate?', tenantId: 'tenant-evil' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(qaService.startQuestion).not.toHaveBeenCalled();
    });

    // `mcp-ask` floors at `UserRole.Member` — the lowest rank `ROLE_RANK` defines — so no
    // *recognized* role sits below it. `StepPolicyAuthzHook.authorize`'s other fail-closed branch
    // (an unrecognized `context.role`) is the only way to exercise a refusal on this exact step,
    // and it proves the same thing a below-floor role would: a caller who does not clear `mcp-ask`'s
    // minimum is refused before `QaService.startQuestion` ever runs.
    it("should refuse a caller whose role does not meet mcp-ask's Member minimum, without starting any workflow", async () => {
      const { service, qaService } = await buildHarness();
      const unrecognizedRoleContext = {
        actorId: 'actor-x',
        tenantId: 'tenant-a',
        role: 'guest' as UserRole,
      };
      const client = await connectClient(service.buildServer(unrecognizedRoleContext));

      const result = await client.callTool({
        name: ASK_EVIDENCE_TOOL_NAME,
        arguments: { question: 'What was the cap rate?' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('authz-denied');
      expect(qaService.startQuestion).not.toHaveBeenCalled();
    });
  });

  describe('tools/call — verify_claims', () => {
    it('should delegate to ClaimVerificationService using the tenant derived from the token, not any tool argument', async () => {
      const { service, claimVerificationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: VERIFY_CLAIMS_TOOL_NAME,
        arguments: { claims: ['The cap rate was approximately 6.10%.'] },
      });

      expect(result.isError).toBeUndefined();
      expect(claimVerificationService.verifyClaims).toHaveBeenCalledWith({
        claims: ['The cap rate was approximately 6.10%.'],
        tenantId: 'tenant-a',
        requestedBy: { kind: 'pat', id: 'actor-a' },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual(buildVerifyClaimsResult());
    });

    it('should refuse a claim over VERIFY_CLAIMS_CLAIM_MAX_LENGTH at the schema chokepoint, never calling the service', async () => {
      const { service, claimVerificationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: VERIFY_CLAIMS_TOOL_NAME,
        arguments: { claims: ['a'.repeat(VERIFY_CLAIMS_CLAIM_MAX_LENGTH + 1)] },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(claimVerificationService.verifyClaims).not.toHaveBeenCalled();
    });

    it('should refuse more than VERIFY_CLAIMS_MAX_CLAIMS claims at the schema chokepoint, never calling the service', async () => {
      const { service, claimVerificationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: VERIFY_CLAIMS_TOOL_NAME,
        arguments: {
          claims: Array.from(
            { length: VERIFY_CLAIMS_MAX_CLAIMS + 1 },
            (_, index) => `claim ${index}`,
          ),
        },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(claimVerificationService.verifyClaims).not.toHaveBeenCalled();
    });

    it('should refuse an empty claims array at the schema chokepoint, never calling the service', async () => {
      const { service, claimVerificationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: VERIFY_CLAIMS_TOOL_NAME,
        arguments: { claims: [] },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(claimVerificationService.verifyClaims).not.toHaveBeenCalled();
    });

    it('should refuse an unknown extra argument key rather than silently stripping it', async () => {
      const { service, claimVerificationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: VERIFY_CLAIMS_TOOL_NAME,
        arguments: { claims: ['The cap rate was approximately 6.10%.'], tenantId: 'tenant-evil' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(claimVerificationService.verifyClaims).not.toHaveBeenCalled();
    });

    // `mcp-verify` floors at `UserRole.Member` — the lowest rank `ROLE_RANK` defines — so no
    // *recognized* role sits below it, the same reasoning `MCP_ASK_STEP`'s equivalent test above
    // documents. An unrecognized `context.role` exercises `StepPolicyAuthzHook`'s other fail-closed
    // branch, proving a caller whose role does not resolve is refused before the service ever runs.
    it('should refuse a caller whose role does not resolve, without calling ClaimVerificationService', async () => {
      const { service, claimVerificationService } = await buildHarness();
      const unrecognizedRoleContext = {
        actorId: 'actor-x',
        tenantId: 'tenant-a',
        role: 'guest' as UserRole,
      };
      const client = await connectClient(service.buildServer(unrecognizedRoleContext));

      const result = await client.callTool({
        name: VERIFY_CLAIMS_TOOL_NAME,
        arguments: { claims: ['The cap rate was approximately 6.10%.'] },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('authz-denied');
      expect(claimVerificationService.verifyClaims).not.toHaveBeenCalled();
    });
  });

  describe('tools/call — submit_evidence', () => {
    it('should delegate to EvidenceSubmissionService using the tenant derived from the token, not any tool argument', async () => {
      const { service, evidenceSubmissionService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: SUBMIT_EVIDENCE_TOOL_NAME,
        arguments: {
          filename: 'lease.pdf',
          mimeType: 'application/pdf',
          contentBase64: 'JVBERi0xLjQK',
          sourceLabel: 'Deal room upload',
        },
      });

      expect(result.isError).toBeUndefined();
      expect(evidenceSubmissionService.submit).toHaveBeenCalledWith({
        filename: 'lease.pdf',
        mimeType: 'application/pdf',
        contentBase64: 'JVBERi0xLjQK',
        sourceLabel: 'Deal room upload',
        tenantId: 'tenant-a',
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual(buildSubmitEvidenceResult());
    });

    it('should submit without a sourceLabel argument', async () => {
      const { service, evidenceSubmissionService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: SUBMIT_EVIDENCE_TOOL_NAME,
        arguments: {
          filename: 'lease.pdf',
          mimeType: 'application/pdf',
          contentBase64: 'JVBERi0xLjQK',
        },
      });

      expect(result.isError).toBeUndefined();
      expect(evidenceSubmissionService.submit).toHaveBeenCalledWith({
        filename: 'lease.pdf',
        mimeType: 'application/pdf',
        contentBase64: 'JVBERi0xLjQK',
        sourceLabel: undefined,
        tenantId: 'tenant-a',
      });
    });

    it('should refuse a contentBase64 over SUBMIT_EVIDENCE_MAX_BASE64_CHARS at the schema chokepoint, never calling the service', async () => {
      const { service, evidenceSubmissionService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: SUBMIT_EVIDENCE_TOOL_NAME,
        arguments: {
          filename: 'lease.pdf',
          mimeType: 'application/pdf',
          contentBase64: 'a'.repeat(SUBMIT_EVIDENCE_MAX_BASE64_CHARS + 4),
        },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(evidenceSubmissionService.submit).not.toHaveBeenCalled();
    });

    it('should refuse an unknown extra argument key rather than silently stripping it', async () => {
      const { service, evidenceSubmissionService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: SUBMIT_EVIDENCE_TOOL_NAME,
        arguments: {
          filename: 'lease.pdf',
          mimeType: 'application/pdf',
          contentBase64: 'JVBERi0xLjQK',
          tenantId: 'tenant-evil',
        },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(evidenceSubmissionService.submit).not.toHaveBeenCalled();
    });

    // `mcp-submit` floors at `UserRole.Member` — the lowest rank `ROLE_RANK` defines — so no
    // *recognized* role sits below it, the same reasoning `MCP_ASK_STEP`'s equivalent test above
    // documents.
    it("should refuse a caller whose role does not meet mcp-submit's Member minimum, without calling the service", async () => {
      const { service, evidenceSubmissionService } = await buildHarness();
      const unrecognizedRoleContext = {
        actorId: 'actor-x',
        tenantId: 'tenant-a',
        role: 'guest' as UserRole,
      };
      const client = await connectClient(service.buildServer(unrecognizedRoleContext));

      const result = await client.callTool({
        name: SUBMIT_EVIDENCE_TOOL_NAME,
        arguments: {
          filename: 'lease.pdf',
          mimeType: 'application/pdf',
          contentBase64: 'JVBERi0xLjQK',
        },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('authz-denied');
      expect(evidenceSubmissionService.submit).not.toHaveBeenCalled();
    });

    // The typed-4xx mapping (3B.11) is what turns the service's own refusal classes into readable
    // text on this surface, rather than the fixed generic message every other throw collapses to.
    it.each([
      [
        'InvalidBase64ContentException',
        new InvalidBase64ContentException('contentBase64 is not well-formed base64'),
        'InvalidBase64ContentException: contentBase64 is not well-formed base64',
      ],
      [
        'UnsupportedContentTypeException',
        new UnsupportedContentTypeException("Unsupported content type 'image/gif' for file 'x'"),
        "UnsupportedContentTypeException: Unsupported content type 'image/gif' for file 'x'",
      ],
    ])(
      'should surface a %s from the service as typed isError text',
      async (_label, thrown, expectedText) => {
        const { service, evidenceSubmissionService } = await buildHarness();
        evidenceSubmissionService.submit.mockRejectedValue(thrown);
        const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

        const result = await client.callTool({
          name: SUBMIT_EVIDENCE_TOOL_NAME,
          arguments: {
            filename: 'x',
            mimeType: 'image/gif',
            contentBase64: 'JVBERi0xLjQK',
          },
        });

        expect(result.isError).toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toBe(expectedText);
      },
    );
  });

  describe('tools/call — lookup_fact', () => {
    it('should delegate to LedgerService.resolveValue using the tenant derived from the token, not any tool argument', async () => {
      const { service, ledgerService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: LOOKUP_FACT_TOOL_NAME,
        arguments: { entity: 'Northgate Business Park', measure: 'cap_rate', period: '2026-Q1' },
      });

      expect(result.isError).toBeUndefined();
      expect(ledgerService.resolveValue).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: '2026-Q1',
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual(buildLedgerResolution());
    });

    it('should resolve without a period argument', async () => {
      const { service, ledgerService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: LOOKUP_FACT_TOOL_NAME,
        arguments: { entity: 'Northgate Business Park', measure: 'cap_rate' },
      });

      expect(result.isError).toBeUndefined();
      expect(ledgerService.resolveValue).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: undefined,
      });
    });

    it('should accept a period at LOOKUP_FACT_PERIOD_MAX_LENGTH, the longest key derive-period.ts can store', async () => {
      const { service, ledgerService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));
      const period = unparseablePeriodKey('x'.repeat(80));
      expect(period).toHaveLength(LOOKUP_FACT_PERIOD_MAX_LENGTH);

      const result = await client.callTool({
        name: LOOKUP_FACT_TOOL_NAME,
        arguments: { entity: 'Northgate Business Park', measure: 'cap_rate', period },
      });

      expect(result.isError).toBeUndefined();
      expect(ledgerService.resolveValue).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period,
      });
    });

    it('should refuse a call carrying a tenantId argument rather than let it reach the handler', async () => {
      const { service, ledgerService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: LOOKUP_FACT_TOOL_NAME,
        arguments: {
          entity: 'Northgate Business Park',
          measure: 'cap_rate',
          tenantId: 'tenant-evil',
        },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(ledgerService.resolveValue).not.toHaveBeenCalled();
    });
  });

  describe('tools/call — get_attestation', () => {
    it('should export for an answer when only answerId is given, delegating to AttestationService.exportForAnswer', async () => {
      const { service, attestationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: GET_ATTESTATION_TOOL_NAME,
        arguments: { answerId: 'answer-1' },
      });

      expect(result.isError).toBeUndefined();
      expect(attestationService.exportForAnswer).toHaveBeenCalledWith('answer-1', 'tenant-a');
      expect(attestationService.exportForVerification).not.toHaveBeenCalled();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual(buildAttestationBundle());
    });

    it('should export for a verification when only verificationId is given, delegating to AttestationService.exportForVerification', async () => {
      const { service, attestationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: GET_ATTESTATION_TOOL_NAME,
        arguments: { verificationId: 'verification-1' },
      });

      expect(result.isError).toBeUndefined();
      expect(attestationService.exportForVerification).toHaveBeenCalledWith(
        'verification-1',
        'tenant-a',
      );
      expect(attestationService.exportForAnswer).not.toHaveBeenCalled();
    });

    it('should refuse with a typed 400 when both answerId and verificationId are given', async () => {
      const { service, attestationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: GET_ATTESTATION_TOOL_NAME,
        arguments: { answerId: 'answer-1', verificationId: 'verification-1' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe(
        `${AttestationSubjectRequiredException.name}: Exactly one of answerId or verificationId is required`,
      );
      expect(attestationService.exportForAnswer).not.toHaveBeenCalled();
      expect(attestationService.exportForVerification).not.toHaveBeenCalled();
    });

    it('should refuse with a typed 400 when neither answerId nor verificationId is given', async () => {
      const { service, attestationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({ name: GET_ATTESTATION_TOOL_NAME, arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe(
        `${AttestationSubjectRequiredException.name}: Exactly one of answerId or verificationId is required`,
      );
      expect(attestationService.exportForAnswer).not.toHaveBeenCalled();
      expect(attestationService.exportForVerification).not.toHaveBeenCalled();
    });

    it('should refuse an id over ATTESTATION_ID_MAX_LENGTH at the schema chokepoint, never calling the service', async () => {
      const { service, attestationService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: GET_ATTESTATION_TOOL_NAME,
        arguments: { answerId: 'a'.repeat(ATTESTATION_ID_MAX_LENGTH + 1) },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('invalid-arguments');
      expect(attestationService.exportForAnswer).not.toHaveBeenCalled();
    });
  });

  describe('spend gate', () => {
    it('should advertise and register search_evidence, ask_evidence, and verify_claims when the daily spend ceiling is positive', async () => {
      const { service, evidenceRetrievalService, claimVerificationService } = await buildHarness(
        60,
        20,
        60000,
        50,
      );
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          SEARCH_EVIDENCE_TOOL_NAME,
          ASK_EVIDENCE_TOOL_NAME,
          VERIFY_CLAIMS_TOOL_NAME,
        ]),
      );

      const searchResult = await client.callTool({
        name: SEARCH_EVIDENCE_TOOL_NAME,
        arguments: { query: 'cap rate' },
      });
      expect(searchResult.isError).toBeUndefined();
      expect(evidenceRetrievalService.retrieve).toHaveBeenCalledWith({
        questionText: 'cap rate',
        tenantId: 'tenant-a',
      });

      const askResult = await client.callTool({
        name: ASK_EVIDENCE_TOOL_NAME,
        arguments: { question: 'What was the cap rate?' },
      });
      expect(askResult.isError).toBeUndefined();

      const verifyResult = await client.callTool({
        name: VERIFY_CLAIMS_TOOL_NAME,
        arguments: { claims: ['The cap rate was approximately 6.10%.'] },
      });
      expect(verifyResult.isError).toBeUndefined();
      expect(claimVerificationService.verifyClaims).toHaveBeenCalledWith({
        claims: ['The cap rate was approximately 6.10%.'],
        tenantId: 'tenant-a',
        requestedBy: { kind: 'pat', id: 'actor-a' },
      });
    });

    // Regression for the finding that `search_evidence` billed Voyage (via
    // `EvidenceRetrievalService.retrieve` → `MongoHybridRetrievalStore.search` → `embedQuery` →
    // `SpendGuardEmbeddingProvider`, which fails OPEN at this same `dailyLimitUsd <= 0` value) even
    // though the MCP gate closed on it — `search_evidence` must be withheld exactly like
    // `ask_evidence`/`verify_claims`, leaving only the two tools that genuinely spend nothing.
    it('should withhold search_evidence, ask_evidence, and verify_claims from tools/list and refuse calling any of them when the daily spend ceiling is 0', async () => {
      const { service, evidenceRetrievalService, qaService, claimVerificationService, logger } =
        await buildHarness(60, 20, 60000, 0);
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          GET_ANSWER_TOOL_NAME,
          REQUEST_RESOLUTION_TOOL_NAME,
          SUBMIT_EVIDENCE_TOOL_NAME,
          LOOKUP_FACT_TOOL_NAME,
          GET_ATTESTATION_TOOL_NAME,
        ].sort(),
      );

      const searchResult = await client.callTool({
        name: SEARCH_EVIDENCE_TOOL_NAME,
        arguments: { query: 'cap rate' },
      });
      expect(searchResult.isError).toBe(true);
      const searchContent = searchResult.content as Array<{ type: string; text: string }>;
      expect(searchContent[0].text).toContain('tool-not-registered');
      expect(evidenceRetrievalService.retrieve).not.toHaveBeenCalled();

      const askResult = await client.callTool({
        name: ASK_EVIDENCE_TOOL_NAME,
        arguments: { question: 'What was the cap rate?' },
      });
      expect(askResult.isError).toBe(true);
      const askContent = askResult.content as Array<{ type: string; text: string }>;
      expect(askContent[0].text).toContain('tool-not-registered');
      expect(qaService.startQuestion).not.toHaveBeenCalled();

      const verifyResult = await client.callTool({
        name: VERIFY_CLAIMS_TOOL_NAME,
        arguments: { claims: ['The cap rate was approximately 6.10%.'] },
      });
      expect(verifyResult.isError).toBe(true);
      const verifyContent = verifyResult.content as Array<{ type: string; text: string }>;
      expect(verifyContent[0].text).toContain('tool-not-registered');
      expect(claimVerificationService.verifyClaims).not.toHaveBeenCalled();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('MODEL_SPEND_DAILY_LIMIT_USD'),
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(SEARCH_EVIDENCE_TOOL_NAME));

      // `submit_evidence`, `lookup_fact`, and `get_attestation` spend nothing in-call
      // (`McpServerService`'s own doc comment) — they stay reachable with the ceiling disabled,
      // unlike the three tools withheld above.
      const lookupResult = await client.callTool({
        name: LOOKUP_FACT_TOOL_NAME,
        arguments: { entity: 'Northgate Business Park', measure: 'cap_rate' },
      });
      expect(lookupResult.isError).toBeUndefined();
    });
  });

  describe('tools/call — audit trail', () => {
    // `search_evidence` inherits no audit row from the service it delegates to
    // (`EvidenceRetrievalService` is a pure read, shared with the worker's retrieval loop), so
    // without the boundary write a PAT could run corpus queries returning full chunk text and
    // leave nothing recording who read what.
    it('should record an executed tool call against the verified actor and tenant, without the call arguments', async () => {
      const { service, auditService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: SEARCH_EVIDENCE_TOOL_NAME,
        arguments: { query: 'cap rate' },
      });

      expect(result.isError).toBeUndefined();
      expect(auditService.record.mock.calls).toEqual([
        [
          {
            action: MCP_TOOL_CALL_EXECUTED_ACTION,
            actorId: 'actor-a',
            subject: { entityType: 'User', entityId: 'actor-a' },
            tenantId: 'tenant-a',
            origin: 'mcp',
            toolName: SEARCH_EVIDENCE_TOOL_NAME,
            refusalReason: undefined,
          },
        ],
      ]);
      // Arguments are model-controlled and can carry corpus text — the row answers "who called
      // what, when", never "what did the payload say". Asserted on the whole serialized call, so a
      // future field that smuggled them in fails here too.
      expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('cap rate');
    });

    // The refusal case is the one no service-level audit write could ever produce: the call is
    // rejected at the chokepoint and never reaches a service at all.
    it('should record a refused tool call with the chokepoint reason, never the refusal detail', async () => {
      const { service, auditService, conflictsService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: REQUEST_RESOLUTION_TOOL_NAME,
        arguments: { conflictId: 'conflict-1', winningFactId: 'fact-1' },
      });

      expect(result.isError).toBe(true);
      expect(conflictsService.requestResolution).not.toHaveBeenCalled();
      expect(auditService.record.mock.calls).toEqual([
        [
          {
            action: MCP_TOOL_CALL_REFUSED_ACTION,
            actorId: 'actor-a',
            subject: { entityType: 'User', entityId: 'actor-a' },
            tenantId: 'tenant-a',
            origin: 'mcp',
            toolName: REQUEST_RESOLUTION_TOOL_NAME,
            refusalReason: 'authz-denied',
          },
        ],
      ]);
    });

    // An unregistered name is a probe worth keeping verbatim: the recorded `toolName` is what a
    // reviewer needs to see that someone went looking for a tool this surface does not have.
    it('should record a refused call for an unregistered tool name, keeping the attempted name', async () => {
      const { service, auditService } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      await client.callTool({ name: 'delete_everything', arguments: {} });

      expect(auditService.record.mock.calls).toEqual([
        [
          expect.objectContaining({
            action: MCP_TOOL_CALL_REFUSED_ACTION,
            toolName: 'delete_everything',
            refusalReason: 'tool-not-registered',
          }),
        ],
      ]);
    });

    // Fails CLOSED: the audit write is awaited before the tool result goes back, so a failed write
    // replaces whatever the handler produced with the same fixed-message result a handler throw
    // itself gets — the handler's own result is never disclosed without a record of the call, and
    // the audit write's own error message never reaches the client either. The audit write throws
    // inside the inner `finally`, which the inner `catch` cannot see (a `finally` throw supersedes
    // whatever the `try` returned) — this is the outer `catch` in `buildServer`'s own path, not the
    // inner one the handler-throw tests above exercise.
    it('should return the fixed message when the audit write rejects with a Mongo-shaped Error, leaking neither message nor code', async () => {
      const { service, auditService, logger } = await buildHarness();
      const mongoError = Object.assign(
        new Error('E11000 duplicate key error collection: evidence.auditEvents'),
        { code: 11000 },
      );
      auditService.record.mockRejectedValue(mongoError);
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: SEARCH_EVIDENCE_TOOL_NAME,
        arguments: { query: 'cap rate' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe('Internal server error');
      expect(content[0].text).not.toContain('E11000');
      expect(content[0].text).not.toContain('11000');
      expect(JSON.stringify(result)).not.toContain('E11000');
      expect(JSON.stringify(result)).not.toContain('11000');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('E11000 duplicate key error collection'),
        mongoError.stack,
      );
    });

    // The `error instanceof Error` branch this test drives is otherwise unreachable: nothing else
    // in this file rejects the audit write with a non-`Error` value, so without this the outer
    // `catch`'s `false` branch — `String(error)` for the message, `undefined` for the (missing)
    // stack — never runs.
    it('should return the fixed message when the audit write rejects with a non-Error value, without throwing on the missing stack', async () => {
      const { service, auditService, logger } = await buildHarness();
      auditService.record.mockRejectedValue('a thrown string, not an Error instance');
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: SEARCH_EVIDENCE_TOOL_NAME,
        arguments: { query: 'cap rate' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe('Internal server error');
      expect(content[0].text).not.toContain('a thrown string');
      expect(JSON.stringify(result)).not.toContain('a thrown string');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('a thrown string, not an Error instance'),
        undefined,
      );
    });

    // Regression for the id-enumeration gap: a fully authenticated, fully authorized `get_answer`
    // for a non-existent id previously threw before the audit write ran at all, leaving no row —
    // silent on every miss. The write now sits in a `finally` around the executor call, so a
    // handler throw still leaves exactly one row, carrying a distinct action from both a success
    // and a chokepoint refusal. Parameterised over the error shapes a tool handler can actually
    // produce — this process has neither `GlobalExceptionFilter` nor the SSE streams' `catchError`,
    // so none of them may reach the client with its own message, not only the Mongo duplicate-key
    // case.
    it.each([
      [
        'a Mongo duplicate-key error',
        Object.assign(new Error('E11000 duplicate key error collection: evidence.answers'), {
          code: 11000,
        }),
      ],
      [
        'a Mongoose validation error',
        Object.assign(new Error('Answer validation failed: id: Path `id` is required.'), {
          name: 'ValidationError',
        }),
      ],
      ['a plain Error', new Error('a very specific internal detail')],
      [
        'a 5xx BaseException',
        new BaseException('internal detail', HttpStatus.INTERNAL_SERVER_ERROR),
      ],
      ['a thrown non-Error value', 'a thrown string'],
    ])(
      'should return the fixed message and leave a failed-action audit row for %s, never the exception detail',
      async (_label, thrown) => {
        const { service, auditService, qaService, logger } = await buildHarness();
        qaService.getAnswerById.mockRejectedValue(thrown);
        const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

        const result = await client.callTool({
          name: GET_ANSWER_TOOL_NAME,
          arguments: { answerId: 'missing' },
        });

        expect(result.isError).toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toBe('Internal server error');

        const realDetail = thrown instanceof Error ? thrown.message : String(thrown);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining(realDetail),
          thrown instanceof Error ? thrown.stack : undefined,
        );

        expect(auditService.record.mock.calls).toEqual([
          [
            {
              action: MCP_TOOL_CALL_FAILED_ACTION,
              actorId: 'actor-a',
              subject: { entityType: 'User', entityId: 'actor-a' },
              tenantId: 'tenant-a',
              origin: 'mcp',
              toolName: GET_ANSWER_TOOL_NAME,
              refusalReason: undefined,
            },
          ],
        ]);
        expect(MCP_TOOL_CALL_FAILED_ACTION).not.toBe(MCP_TOOL_CALL_EXECUTED_ACTION);
        expect(MCP_TOOL_CALL_FAILED_ACTION).not.toBe(MCP_TOOL_CALL_REFUSED_ACTION);
      },
    );

    it('should surface a 4xx HttpException as its own class name and message, still leaving a failed-action audit row', async () => {
      const { service, auditService, qaService, logger } = await buildHarness();
      qaService.getAnswerById.mockRejectedValue(
        new AnswerNotFoundException("Answer 'missing' not found"),
      );
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const result = await client.callTool({
        name: GET_ANSWER_TOOL_NAME,
        arguments: { answerId: 'missing' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe("AnswerNotFoundException: Answer 'missing' not found");
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("AnswerNotFoundException: Answer 'missing' not found"),
      );

      expect(auditService.record.mock.calls).toEqual([
        [
          {
            action: MCP_TOOL_CALL_FAILED_ACTION,
            actorId: 'actor-a',
            subject: { entityType: 'User', entityId: 'actor-a' },
            tenantId: 'tenant-a',
            origin: 'mcp',
            toolName: GET_ANSWER_TOOL_NAME,
            refusalReason: undefined,
          },
        ],
      ]);
    });
  });

  describe('authenticate', () => {
    it('should refuse a missing Authorization header', async () => {
      const { service } = await buildHarness();

      await expect(service.authenticate(undefined)).resolves.toBeNull();
    });

    it('should refuse a header with the wrong scheme', async () => {
      const { service } = await buildHarness();

      await expect(service.authenticate(`Basic ${TENANT_A_TOKEN}`)).resolves.toBeNull();
    });

    it('should refuse a Bearer scheme with no token', async () => {
      const { service } = await buildHarness();

      await expect(service.authenticate('Bearer ')).resolves.toBeNull();
    });

    it('should refuse a token TOKEN_VERIFIER does not recognize, revoked, or expired', async () => {
      const { service, tokenVerifier } = await buildHarness();
      tokenVerifier.verify.mockResolvedValue(null);

      await expect(service.authenticate(`Bearer ${TENANT_A_TOKEN}`)).resolves.toBeNull();
    });

    it('should resolve a ToolExecutionContext from a live, verified token', async () => {
      const { service, tokenVerifier } = await buildHarness();
      tokenVerifier.verify.mockResolvedValue(TENANT_A_IDENTITY);

      const context = await service.authenticate(`Bearer ${TENANT_A_TOKEN}`);

      expect(context).toEqual({ tenantId: 'tenant-a', actorId: 'actor-a', role: UserRole.Member });
      // `.mock.calls` rather than `toHaveBeenCalledWith(tokenVerifier.verify, ...)` — passing the
      // interface-typed method itself to `expect()` trips `@typescript-eslint/unbound-method`
      // (same pattern `tool-executor.service.spec.ts` uses for `mockAuthzHook.authorize`).
      expect(tokenVerifier.verify.mock.calls).toEqual([[TENANT_A_TOKEN]]);
    });
  });

  describe('checkRateLimit', () => {
    it('should allow calls up to the configured per-minute limit, then refuse', async () => {
      const { service } = await buildHarness(2);

      expect(service.checkRateLimit('actor-a')).toBe(true);
      expect(service.checkRateLimit('actor-a')).toBe(true);
      expect(service.checkRateLimit('actor-a')).toBe(false);
    });

    it('should reset the budget once the window elapses', async () => {
      const { service } = await buildHarness(1);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);

      expect(service.checkRateLimit('actor-a')).toBe(true);
      expect(service.checkRateLimit('actor-a')).toBe(false);

      nowSpy.mockReturnValue(60_001);
      expect(service.checkRateLimit('actor-a')).toBe(true);
    });

    it('should track separate budgets per actor', async () => {
      const { service } = await buildHarness(1);

      expect(service.checkRateLimit('actor-a')).toBe(true);
      expect(service.checkRateLimit('actor-b')).toBe(true);
    });

    // Fails CLOSED over the whole domain `cost` accepts, not only its non-positive values: a
    // non-integral or non-finite cost must be refused too, because the admission check
    // (`spent + cost > limit`) is only sound once every stored charge is a positive integer.
    // `NaN` is the sharpest instance — `spent + NaN > limit` is `false`, so an unguarded `NaN`
    // charge is admitted for free *and* poisons the key: every later comparison against a
    // `NaN`-bearing running total is also `false`, admitting charges past the budget forever.
    // `countRateLimitCost` floors the cost it derives from a request body at 1 elsewhere; this is
    // the defence-in-depth guard for whatever a future caller passes directly.
    it.each([0, -1, -100, NaN, Infinity, -Infinity, 0.5, -0.5])(
      'should refuse a call whose cost is %p, admitting nothing and leaving the budget intact',
      async (cost) => {
        const { service } = await buildHarness(5);

        expect(service.checkRateLimit('actor-a', cost)).toBe(false);
        // The invalid cost stored no charge and poisoned nothing — a legitimate charge afterward
        // still has the full budget available.
        expect(service.checkRateLimit('actor-a', 5)).toBe(true);
      },
    );

    // Regression coverage for the JSON-RPC batching bypass: a batch of N tool calls must consume
    // N units from the limiter — never the flat 1-per-POST cost that let an arbitrarily large batch
    // array spend one unit of budget while the SDK dispatched every request inside it.
    it('should consume the given cost from a fresh window in a single call', async () => {
      const { service } = await buildHarness(60);

      expect(service.checkRateLimit('actor-a', 40)).toBe(true);
      expect(service.checkRateLimit('actor-a', 20)).toBe(true);
      expect(service.checkRateLimit('actor-a', 1)).toBe(false);
    });

    it('should refuse a batch whose cost alone exceeds the per-window budget, consuming nothing', async () => {
      const { service } = await buildHarness(60);

      expect(service.checkRateLimit('actor-a', 61)).toBe(false);
      // Refusing the oversized batch must not have consumed any of the window's budget — a
      // same-window call within budget still succeeds afterward.
      expect(service.checkRateLimit('actor-a', 60)).toBe(true);
    });

    it('should refuse a batch that would exceed the remaining budget of an existing window, consuming nothing', async () => {
      const { service } = await buildHarness(60);

      expect(service.checkRateLimit('actor-a', 50)).toBe(true);
      expect(service.checkRateLimit('actor-a', 20)).toBe(false);
      // The refused batch consumed nothing — the remaining 10 units are still available.
      expect(service.checkRateLimit('actor-a', 10)).toBe(true);
    });

    // Bounds the charge map's growth to currently active actors — without this, a map entry
    // survives forever once a caller's window has fully elapsed and is never checked again.
    it('should evict an actor whose window has fully elapsed once any call runs, freeing the entry', async () => {
      const { service } = await buildHarness(1);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);

      expect(service.checkRateLimit('actor-a')).toBe(true);

      nowSpy.mockReturnValue(60_001);
      // A different actor's call still evicts `actor-a`'s expired window: the amortised sweep
      // visits every key present in a map this small within one call's batch, so eviction is not
      // limited to the evicted key's own next lookup even though the sweep no longer walks the
      // whole map unconditionally on every call.
      expect(service.checkRateLimit('actor-b')).toBe(true);
      // `actor-a`'s budget of 1 is fresh again: the entry was evicted, not merely stale-but-present.
      expect(service.checkRateLimit('actor-a')).toBe(true);
    });
  });

  describe('checkPreAuthIpRateLimit', () => {
    it('should allow requests up to the configured per-window cap, then refuse', async () => {
      const { service } = await buildHarness(60, 2);

      expect(service.checkPreAuthIpRateLimit('1.2.3.4')).toBe(true);
      expect(service.checkPreAuthIpRateLimit('1.2.3.4')).toBe(true);
      expect(service.checkPreAuthIpRateLimit('1.2.3.4')).toBe(false);
    });

    it('should reset the budget once the configured window elapses', async () => {
      const { service } = await buildHarness(60, 1, 1000);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);

      expect(service.checkPreAuthIpRateLimit('1.2.3.4')).toBe(true);
      expect(service.checkPreAuthIpRateLimit('1.2.3.4')).toBe(false);

      nowSpy.mockReturnValue(1_001);
      expect(service.checkPreAuthIpRateLimit('1.2.3.4')).toBe(true);
    });

    it('should track separate budgets per IP', async () => {
      const { service } = await buildHarness(60, 1);

      expect(service.checkPreAuthIpRateLimit('1.2.3.4')).toBe(true);
      expect(service.checkPreAuthIpRateLimit('5.6.7.8')).toBe(true);
    });

    // The window this limiter uses is distinct from `checkRateLimit`'s actor-keyed one — a caller
    // that has exhausted its post-auth budget must not be refused here, and vice versa, since the
    // two police different populations (unverified IPs vs verified actors).
    it('should apply a budget independent of the actor-keyed limiter', async () => {
      const { service } = await buildHarness(1, 1);

      expect(service.checkRateLimit('actor-a')).toBe(true);
      expect(service.checkRateLimit('actor-a')).toBe(false);
      expect(service.checkPreAuthIpRateLimit('1.2.3.4')).toBe(true);
    });
  });

  // Regression coverage for the O(active keys)-per-call eviction defect: a whole-map sweep on
  // every call means the number of `Map.prototype.delete` calls one call makes scales with how
  // many keys are tracked, not with the amortised sweep's own batch size. `Map.prototype.delete`
  // is spied on rather than timed, per this codebase's own guidance against wall-clock assertions
  // that are flaky on a loaded machine — the call count is exact and deterministic either way.
  describe('amortised sweep bookkeeping stays bounded per call', () => {
    function primeIp(index: number): string {
      return `10.0.${Math.floor(index / 250)}.${index % 250}`;
    }

    it("should touch at most one sweep batch of the pre-auth IP map's keys per call, independent of how many are tracked", async () => {
      const trackedKeys = MCP_RATE_LIMIT_SWEEP_BATCH_SIZE * 50;
      const { service } = await buildHarness(60, trackedKeys + 10, 60_000);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);

      for (let index = 0; index < trackedKeys; index += 1) {
        expect(service.checkPreAuthIpRateLimit(primeIp(index))).toBe(true);
      }

      nowSpy.mockReturnValue(60_001);

      const deleteSpy = jest.spyOn(Map.prototype, 'delete');
      try {
        expect(service.checkPreAuthIpRateLimit('fresh-caller')).toBe(true);

        // A per-call whole-map sweep would delete every one of `trackedKeys` now-expired entries
        // here; the amortised sweep deletes at most one batch, which is what keeps this call's
        // own cost independent of how many keys the map is tracking.
        expect(deleteSpy.mock.calls.length).toBeLessThanOrEqual(MCP_RATE_LIMIT_SWEEP_BATCH_SIZE);
        expect(deleteSpy.mock.calls.length).toBeLessThan(trackedKeys);
      } finally {
        deleteSpy.mockRestore();
      }
    });

    it('should reclaim every stale key across a bounded run of calls, resuming rather than restarting each time', async () => {
      const trackedKeys = MCP_RATE_LIMIT_SWEEP_BATCH_SIZE * 2;
      const { service } = await buildHarness(60, trackedKeys + 20, 60_000);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);

      for (let index = 0; index < trackedKeys; index += 1) {
        expect(service.checkPreAuthIpRateLimit(primeIp(index))).toBe(true);
      }

      nowSpy.mockReturnValue(60_001);

      const deleteSpy = jest.spyOn(Map.prototype, 'delete');
      let totalDeleted = 0;
      try {
        for (let call = 0; call < 10; call += 1) {
          deleteSpy.mockClear();
          expect(service.checkPreAuthIpRateLimit(`fresh-caller-${call}`)).toBe(true);

          // Bounded on every one of these calls too, not just the first.
          expect(deleteSpy.mock.calls.length).toBeLessThanOrEqual(MCP_RATE_LIMIT_SWEEP_BATCH_SIZE);
          totalDeleted += deleteSpy.mock.calls.length;
        }

        // Spread across a small, bounded run of calls, the persisted cursor reaches every stale
        // key rather than re-sweeping the same batch forever — the resumption a cursor cleared
        // only on a completed pass exists for.
        expect(totalDeleted).toBe(trackedKeys);
      } finally {
        deleteSpy.mockRestore();
      }
    });
  });

  // The admission property both limiters carry, stated over every window-length interval rather
  // than over the intervals a counter happens to align to: for any key and any instant `t`, the
  // units admitted for that key in `[t, t + windowMs)` never exceed the configured limit. A
  // fixed-window counter violates it by up to 2x — a full budget spent just before a boundary and
  // again just after sits inside one window-wide interval — so the sweep below drives generated
  // schedules whose timestamps land on and around boundaries, with varying costs and interleaved
  // keys, instead of a fixed list of examples that can only find the instances it names.
  describe('admission property across every window-length interval', () => {
    interface ScheduleEvent {
      readonly at: number;
      readonly cost: number;
      readonly key: string;
    }

    const SWEEP_KEYS = ['caller-a', 'caller-b'];

    /** Deterministic LCG (Numerical Recipes constants) — a failing seed reproduces exactly, which
     *  a `Math.random` schedule would not. */
    function createRandom(seed: number): (bound: number) => number {
      let state = seed;
      return (bound: number) => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state % bound;
      };
    }

    /** Timestamps advance by deltas drawn from a set that lands on, just before, and just after a
     *  window boundary — the instants a fixed window is wrong at, which uniformly random deltas
     *  would only occasionally hit. */
    function generateSchedule(seed: number, windowMs: number, maxCost: number): ScheduleEvent[] {
      const random = createRandom(seed);
      const deltas = [0, 1, Math.floor(windowMs / 3), windowMs - 1, windowMs, windowMs + 1];
      const events: ScheduleEvent[] = [];
      let at = 0;

      for (let index = 0; index < 40; index += 1) {
        at += deltas[random(deltas.length)];
        events.push({
          at,
          cost: 1 + random(maxCost),
          key: SWEEP_KEYS[random(SWEEP_KEYS.length)],
        });
      }

      return events;
    }

    /** The oracle, pinned to the same half-open interval the limiter's own eviction implies: an
     *  admission at `at` counts against every interval starting in `(at - windowMs, at]`. Checking
     *  intervals that start at an admission is sufficient — any interval's admissions are a subset
     *  of the one starting at its earliest admission. */
    function worstWindowLoad(admitted: ScheduleEvent[], windowMs: number): number {
      let worst = 0;

      for (const key of SWEEP_KEYS) {
        const forKey = admitted.filter((event) => event.key === key);
        for (const start of forKey) {
          const load = forKey
            .filter((event) => event.at >= start.at && event.at < start.at + windowMs)
            .reduce((sum, event) => sum + event.cost, 0);
          worst = Math.max(worst, load);
        }
      }

      return worst;
    }

    function drive(
      admit: (key: string, cost: number) => boolean,
      events: readonly ScheduleEvent[],
    ): ScheduleEvent[] {
      const nowSpy = jest.spyOn(Date, 'now');
      const admitted: ScheduleEvent[] = [];

      for (const event of events) {
        nowSpy.mockReturnValue(event.at);
        if (admit(event.key, event.cost)) {
          admitted.push(event);
        }
      }

      return admitted;
    }

    it('should never admit more than the actor limit in any window-length interval', async () => {
      const limit = 5;

      for (let seed = 1; seed <= 200; seed += 1) {
        const { service } = await buildHarness(limit);
        const events = generateSchedule(seed, 60_000, 3);
        const admitted = drive((key, cost) => service.checkRateLimit(key, cost), events);
        const worst = worstWindowLoad(admitted, 60_000);

        // Compared as an object so a failing sweep names the seed and the overshoot that produced
        // it, which is what makes the counterexample reproducible.
        expect({ seed, worst, exceeded: worst > limit }).toEqual({
          seed,
          worst,
          exceeded: false,
        });
      }
    });

    it('should never admit more than the pre-auth IP limit in any window-length interval', async () => {
      const limit = 4;
      const windowMs = 30_000;

      for (let seed = 1; seed <= 200; seed += 1) {
        const { service } = await buildHarness(60, limit, windowMs);
        const events = generateSchedule(seed, windowMs, 1);
        const admitted = drive((key) => service.checkPreAuthIpRateLimit(key), events);
        const worst = worstWindowLoad(admitted, windowMs);

        expect({ seed, worst, exceeded: worst > limit }).toEqual({
          seed,
          worst,
          exceeded: false,
        });
      }
    });

    // The sharpest instance of the property above, kept as its own case so a failure names the
    // mechanism rather than a seed. A counter anchored at a key's first request returns the whole
    // budget the instant that anchor elapses, no matter how recently the budget was spent: the
    // second and third calls here are 2ms apart and together spend 3 units against a limit of 2.
    it('should not return budget spent milliseconds ago just because an older spend elapsed', async () => {
      const { service } = await buildHarness(2);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);

      expect(service.checkRateLimit('actor-a', 1)).toBe(true);

      nowSpy.mockReturnValue(59_999);
      expect(service.checkRateLimit('actor-a', 1)).toBe(true);

      nowSpy.mockReturnValue(60_001);
      expect(service.checkRateLimit('actor-a', 2)).toBe(false);
      // Exactly one unit came back — the one spent at t=0, which is now a full window behind.
      expect(service.checkRateLimit('actor-a', 1)).toBe(true);
    });
  });

  describe('role gating, proven against the real StepPolicyAuthzHook this module binds', () => {
    // Every valid `UserRole` already meets `'mcp-read'`'s own minimum (`Member`, the floor of
    // `ROLE_RANK`), so a refusal can't be demonstrated on that step itself. This drives the exact
    // `ToolExecutorService` instance `McpServerService` registered its tools on against a
    // stricter step from the same production `STEP_MINIMUM_ROLE` map, proving both that the
    // bound hook is `StepPolicyAuthzHook` (its own role-mismatch message, not a generic denial)
    // and that a role below a step's minimum is refused, not merely that `search_evidence` works.
    it('should refuse a Member for a step requiring Admin', async () => {
      const { toolExecutor } = await buildHarness();
      const stricterStep: ToolExecutionStep = {
        stepId: 'mcp-mutate',
        allowedTools: [SEARCH_EVIDENCE_TOOL_NAME],
      };

      const result = await toolExecutor.execute({
        step: stricterStep,
        toolName: SEARCH_EVIDENCE_TOOL_NAME,
        rawArgs: { query: 'cap rate' },
        context: TENANT_A_CONTEXT,
      });

      expect(result).toEqual({
        kind: 'refused',
        reason: 'authz-denied',
        detail:
          "role 'member' does not meet the minimum role 'admin' required for step 'mcp-mutate'",
      });
    });
  });
});
