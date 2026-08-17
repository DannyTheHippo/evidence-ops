import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import type { ModelToolDefinition } from '../../../providers/model/model-provider.interface';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionStep,
} from '../../platform/authz/types/tool-definition.type';
import type { EvidenceRetrievalService } from './evidence-retrieval.service';

export const SEARCH_EVIDENCE_TOOL_NAME = 'search_evidence';
export const FETCH_CHUNKS_TOOL_NAME = 'fetch_chunks';

/** The step `AgenticRetrievalService` presents to `ToolExecutorService.execute` — both tools here
 * are read-only, so no other step ever needs to allow them. */
export const AGENTIC_RETRIEVAL_STEP: ToolExecutionStep = {
  stepId: 'agentic-retrieval',
  allowedTools: [SEARCH_EVIDENCE_TOOL_NAME, FETCH_CHUNKS_TOOL_NAME],
};

/**
 * Declared twice, deliberately — `ToolDefinition.argsSchema` is checked by `ToolExecutorService`'s
 * registration-time `applyStrictRecursively` via `instanceof z.ZodObject` against the bare `zod`
 * (v3) import, while `ModelToolDefinition.inputSchema` is converted to JSON Schema via `zod/v4`
 * (see that field's own doc comment: v3/v4 schema instances are not interchangeable at runtime).
 * One shared schema object cannot satisfy both call sites, so each tool's shape is written once
 * per zod major version rather than derived from the other.
 */
const searchEvidenceArgsSchema = z.object({ query: z.string().min(1) });
const searchEvidenceInputSchema = z4.object({ query: z4.string().min(1) });

const fetchChunksArgsSchema = z.object({ ids: z.array(z.string().min(1)).min(1) });
const fetchChunksInputSchema = z4.object({ ids: z4.array(z4.string().min(1)).min(1) });

export const searchEvidenceToolDefinition: ModelToolDefinition = {
  name: SEARCH_EVIDENCE_TOOL_NAME,
  description:
    "Search the tenant's evidence corpus for chunks relevant to a query. Returns short " +
    'snippets, not full chunk text — call fetch_chunks with a returned chunkId to read a ' +
    'chunk in full.',
  inputSchema: searchEvidenceInputSchema,
};

export const fetchChunksToolDefinition: ModelToolDefinition = {
  name: FETCH_CHUNKS_TOOL_NAME,
  description:
    'Fetch the full text of specific chunks by chunkId. Only chunkIds already returned by a ' +
    'prior search_evidence call can be fetched.',
  inputSchema: fetchChunksInputSchema,
};

/**
 * `search_evidence`'s registered handler — the only place in the agentic retrieval loop that
 * performs a real retrieval, and the concrete example of the tenant boundary
 * `ToolExecutionContext`'s own doc comment describes: `context.tenantId` (server-derived) scopes
 * the query, never anything the model could put in `args`. Stateless: every call is an
 * independent `EvidenceRetrievalService.retrieve`, so registering it once on the singleton
 * `ToolExecutorService` is safe under concurrent requests.
 */
export function buildSearchEvidenceTool(
  evidenceRetrievalService: EvidenceRetrievalService,
): ToolDefinition {
  return {
    name: SEARCH_EVIDENCE_TOOL_NAME,
    argsSchema: searchEvidenceArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { query } = args as { query: string };
      return evidenceRetrievalService.retrieve({ questionText: query, tenantId: context.tenantId });
    },
  };
}

/**
 * `fetch_chunks`'s registered handler. Deliberately does no lookup of its own — it exists only to
 * carry `ids` through the chokepoint's authz and zod-strict validation gates. `AgenticRetrievalService`
 * resolves the validated `ids` against the chunks it already retrieved via `search_evidence` earlier
 * in the same loop, so `fetch_chunks` can only ever re-surface a chunk the server itself already
 * retrieved for this tenant — never fetch arbitrary corpus content by a guessed id.
 */
export function buildFetchChunksTool(): ToolDefinition {
  return {
    name: FETCH_CHUNKS_TOOL_NAME,
    argsSchema: fetchChunksArgsSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- ToolDefinition.handler is async by interface; this handler does no I/O of its own (see doc comment above)
    handler: async (args: Record<string, unknown>) => args,
  };
}
