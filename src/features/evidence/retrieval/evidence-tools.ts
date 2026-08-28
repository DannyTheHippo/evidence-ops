import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import type { ModelToolDefinition } from '../../../providers/model/model-provider.interface';
import type {
  ToolDefinition,
  ToolExecutionContext,
} from '../../platform/authz/types/tool-definition.type';
import type { EvidenceRetrievalService } from '../qa/evidence-retrieval.service';

export const SEARCH_EVIDENCE_TOOL_NAME = 'search_evidence';

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

export const searchEvidenceToolDefinition: ModelToolDefinition = {
  name: SEARCH_EVIDENCE_TOOL_NAME,
  description:
    "Search the tenant's evidence corpus for chunks relevant to a query. Returns short " +
    'snippets of matching evidence text, not full chunk text, plus the id and title of the ' +
    'source document each chunk came from, and a relevance score for ranking hits against ' +
    'each other — the score is a fused rank-based value, not a 0-1 similarity or a percentage.',
  inputSchema: searchEvidenceInputSchema,
};

/**
 * `search_evidence`'s registered handler — the only place in the MCP surface that performs a real
 * retrieval, and the concrete example of the tenant boundary `ToolExecutionContext`'s own doc
 * comment describes: `context.tenantId` (server-derived) scopes the query, never anything the
 * model could put in `args`. Stateless: every call is an independent
 * `EvidenceRetrievalService.retrieve`, so registering it once on the singleton
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
