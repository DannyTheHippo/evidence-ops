import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TypedConfigService } from '../../src/config/environment/typed-config.service';
import { ConflictsService } from '../../src/features/evidence/conflicts/conflicts.service';
import { EvidenceRetrievalService } from '../../src/features/evidence/qa/evidence-retrieval.service';
import { QaService } from '../../src/features/evidence/qa/qa.service';
import {
  SEARCH_EVIDENCE_TOOL_NAME,
  searchEvidenceToolDefinition,
} from '../../src/features/evidence/retrieval/evidence-tools';
import {
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '../../src/features/platform/api-keys/token-verifier.interface';
import { TOOL_AUTHZ_HOOK } from '../../src/features/platform/authz/authz-hook.interface';
import { StepPolicyAuthzHook } from '../../src/features/platform/authz/step-policy.authz-hook';
import { ToolExecutorService } from '../../src/features/platform/authz/tool-executor.service';
import type { ToolExecutionStep } from '../../src/features/platform/authz/types/tool-definition.type';
import { McpServerService } from '../../src/mcp/mcp-server.service';
import {
  GET_ANSWER_TOOL_NAME,
  MCP_MUTATE_STEP,
  MCP_READ_STEP,
  REQUEST_RESOLUTION_TOOL_NAME,
} from '../../src/mcp/mcp-tools';
import { PatTokenVerifier } from '../../src/mcp/pat-token.verifier';
import {
  MCP_TOOL_CALL_EXECUTED_ACTION,
  MCP_TOOL_CALL_REFUSED_ACTION,
} from '../../src/mcp/mcp.constant';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { AuditService } from '../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../src/shared/services/logger/logger.service';
import type { AlsContext } from '../../src/shared/types/als-context.type';
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
  readonly qaService: { getAnswerById: jest.Mock };
  readonly conflictsService: { requestResolution: jest.Mock };
  readonly auditService: { record: jest.Mock };
  readonly als: AsyncLocalStorage<AlsContext>;
}

async function buildHarness(rateLimitPerMinute = 60): Promise<Harness> {
  const tokenVerifier: jest.Mocked<TokenVerifier> = { verify: jest.fn() };
  const evidenceRetrievalService = { retrieve: jest.fn().mockResolvedValue([buildChunk()]) };
  const qaService = { getAnswerById: jest.fn().mockResolvedValue(buildAnswerEnvelope()) };
  const conflictsService = { requestResolution: jest.fn().mockResolvedValue(buildRunResult()) };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  const als = new AsyncLocalStorage<AlsContext>();
  const config = getMockTypedConfig({
    mcp: {
      port: 3002,
      rateLimitPerMinute,
      preAuthIpRateLimitWindowMs: 60000,
      preAuthIpRateLimitMaxRequests: 20,
    },
  });

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ToolExecutorService,
      { provide: TOOL_AUTHZ_HOOK, useClass: StepPolicyAuthzHook },
      PatTokenVerifier,
      { provide: TOKEN_VERIFIER, useValue: tokenVerifier },
      { provide: AsyncLocalStorage, useValue: als },
      { provide: TypedConfigService, useValue: config },
      { provide: AppLogger, useValue: getMockLogger() },
      { provide: EvidenceRetrievalService, useValue: evidenceRetrievalService },
      { provide: QaService, useValue: qaService },
      { provide: ConflictsService, useValue: conflictsService },
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
    auditService,
    als,
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
    it('should advertise search_evidence, get_answer, and request_resolution with strict, object-rooted schemas', async () => {
      const { service } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [SEARCH_EVIDENCE_TOOL_NAME, GET_ANSWER_TOOL_NAME, REQUEST_RESOLUTION_TOOL_NAME].sort(),
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
    });

    // ADR-0016's whole point for this surface: the tool that *proposes* a conflict resolution
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
    it('should expose exactly the frozen tool set on each MCP step, with no approval-deciding tool on either', async () => {
      const { service } = await buildHarness();
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [SEARCH_EVIDENCE_TOOL_NAME, GET_ANSWER_TOOL_NAME, REQUEST_RESOLUTION_TOOL_NAME].sort(),
      );
      expect(MCP_READ_STEP.allowedTools).toEqual([SEARCH_EVIDENCE_TOOL_NAME, GET_ANSWER_TOOL_NAME]);
      expect(MCP_MUTATE_STEP.allowedTools).toEqual([REQUEST_RESOLUTION_TOOL_NAME]);
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
    // surfaces as a protocol error rather than disclosing tool output with no record of the call.
    it('should fail the call when the audit write fails, rather than returning the tool result unrecorded', async () => {
      const { service, auditService } = await buildHarness();
      auditService.record.mockRejectedValue(new Error('audit write failed'));
      const client = await connectClient(service.buildServer(TENANT_A_CONTEXT));

      // A throw from the handler becomes a JSON-RPC error response, so the client rejects and no
      // `CallToolResult` — and therefore no chunk text — ever reaches the caller.
      await expect(
        client.callTool({ name: SEARCH_EVIDENCE_TOOL_NAME, arguments: { query: 'cap rate' } }),
      ).rejects.toThrow('audit write failed');
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
        stepId: 'data-room-export',
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
          "role 'member' does not meet the minimum role 'admin' required for step 'data-room-export'",
      });
    });
  });
});
