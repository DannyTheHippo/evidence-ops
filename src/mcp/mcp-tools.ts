import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import type { ConflictsService } from '../features/evidence/conflicts/conflicts.service';
import {
  SEARCH_EVIDENCE_TOOL_NAME,
  searchEvidenceToolDefinition,
} from '../features/evidence/retrieval/evidence-tools';
import type { QaService } from '../features/evidence/qa/qa.service';
import type { ModelToolDefinition } from '../providers/model/model-provider.interface';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionStep,
} from '../features/platform/authz/types/tool-definition.type';

export const GET_ANSWER_TOOL_NAME = 'get_answer';
export const REQUEST_RESOLUTION_TOOL_NAME = 'request_resolution';

/** The step this process presents to `ToolExecutorService.execute` for every read-only tool call
 *  it proxies — `search_evidence` reused as-is from the retrieval feature
 *  (`buildSearchEvidenceTool` in `../features/evidence/retrieval/evidence-tools.ts`) plus
 *  `get_answer`. Kept disjoint from `MCP_MUTATE_STEP` below — a read token and a mutating token
 *  stay distinguishable in policy because the two never share a step. */
export const MCP_READ_STEP: ToolExecutionStep = {
  stepId: 'mcp-read',
  allowedTools: [SEARCH_EVIDENCE_TOOL_NAME, GET_ANSWER_TOOL_NAME],
};

/** The step presented for `request_resolution`, this surface's only mutating tool. Never carries
 *  a read-only tool — see `MCP_READ_STEP`'s own doc comment for why the split matters to policy. */
export const MCP_MUTATE_STEP: ToolExecutionStep = {
  stepId: 'mcp-mutate',
  allowedTools: [REQUEST_RESOLUTION_TOOL_NAME],
};

/**
 * `search_evidence` as this surface advertises it. The handler is `evidence-tools.ts`'s
 * `buildSearchEvidenceTool` unchanged, and `searchEvidenceToolDefinition.inputSchema` is reused as
 * declared there; only the description differs, because what a caller receives differs.
 * `McpServerService` serializes the retrieval result as it stands, so every hit arrives with its
 * full chunk text — the base definition's own description promises only a short snippet, which
 * would understate what this surface actually returns.
 */
export const mcpSearchEvidenceToolDefinition: ModelToolDefinition = {
  ...searchEvidenceToolDefinition,
  description:
    "Search the tenant's evidence corpus for chunks relevant to a query. Returns each matching " +
    'chunk in full — its complete text, its chunkId, and the locator that points back into the ' +
    'source document. There is no separate fetch step on this surface, and no tool for reading a ' +
    'chunk this search did not return.',
};

const getAnswerArgsSchema = z.object({ answerId: z.string().min(1) });
// `.strict()` here (unlike `evidence-tools.ts`'s sibling schema, which feeds a model call rather
// than an advertised `tools/list` entry) so the JSON Schema this surface advertises declares
// `additionalProperties: false` — matching, not merely approximating, the strictness
// `ToolExecutorService.registerTool` enforces on every registered tool regardless.
const getAnswerInputSchema = z4.object({ answerId: z4.string().min(1) }).strict();

export const getAnswerToolDefinition: ModelToolDefinition = {
  name: GET_ANSWER_TOOL_NAME,
  description:
    'Fetch a previously started question by its answerId: run status, the verified answer ' +
    '(once complete), and its citations with their locators. Does not start a new question — ' +
    'this surface has no tool for that.',
  inputSchema: getAnswerInputSchema,
};

/**
 * `get_answer`'s registered handler. `context.actorId`/`context.tenantId` — server-derived from
 * the verified PAT, never from `args` — are the only identity `QaService.getAnswerById` ever
 * sees; `answerId` is the sole model-supplied argument, and a cross-tenant id 404s exactly like a
 * missing one (see that method's own doc comment), so no argument can widen which tenant's
 * answers are reachable.
 */
export function buildGetAnswerTool(qaService: QaService): ToolDefinition {
  return {
    name: GET_ANSWER_TOOL_NAME,
    argsSchema: getAnswerArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { answerId } = args as { answerId: string };
      return qaService.getAnswerById(answerId, context.actorId, context.tenantId);
    },
  };
}

const requestResolutionArgsSchema = z.object({
  conflictId: z.string().min(1),
  winningFactId: z.string().min(1),
});
// `.strict()` for the same reason `getAnswerInputSchema` carries it above — this shape is
// advertised via `tools/list`, not only fed to a model call.
const requestResolutionInputSchema = z4
  .object({ conflictId: z4.string().min(1), winningFactId: z4.string().min(1) })
  .strict();

export const requestResolutionToolDefinition: ModelToolDefinition = {
  name: REQUEST_RESOLUTION_TOOL_NAME,
  description:
    'Propose winningFactId as the correct value for an open conflict. This only starts a ' +
    "workflow that parks on a human's durable approval — it never decides the conflict itself, " +
    'and this surface has no tool that can. Poll the returned run to see whether a human has ' +
    'approved, rejected, or not yet acted on the proposal.',
  inputSchema: requestResolutionInputSchema,
};

/**
 * `request_resolution`'s registered handler — delegates to `ConflictsService.requestResolution`,
 * the exact method `POST /conflicts/:id/resolution-requests` calls, so conflict loading, proposal
 * validation, and workflow starting run through the one implementation both surfaces share.
 * `context.actorId`/`context.tenantId` scope the request the same way `get_answer` scopes its
 * lookup; `conflictId`/`winningFactId` are the only model-supplied arguments. `requestedBy` takes
 * `context.email` when the verified PAT resolved one, falling back to `context.actorId` only when
 * it did not — matching what `RequestConflictResolutionRequestDto`'s REST path already shows a
 * reviewer. `origin: 'mcp'` is a fixed literal, not read from `context`: it names this handler as
 * the caller, so the approver sees a proposal that reached the workflow through the AI-reachable
 * surface rather than an interactive session, per ADR-0016 § Approvals.
 */
export function buildRequestResolutionTool(conflictsService: ConflictsService): ToolDefinition {
  return {
    name: REQUEST_RESOLUTION_TOOL_NAME,
    argsSchema: requestResolutionArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { conflictId, winningFactId } = args as {
        conflictId: string;
        winningFactId: string;
      };
      return conflictsService.requestResolution({
        conflictId,
        winningFactId,
        actorId: context.actorId,
        requestedBy: context.email ?? context.actorId,
        tenantId: context.tenantId,
        origin: 'mcp',
      });
    },
  };
}
