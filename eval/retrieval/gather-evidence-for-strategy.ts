import type {
  GatherEvidenceInput,
  GatherEvidenceResult,
} from '../../src/features/evidence/qa/agentic-retrieval.service';
import type { RetrieveEvidenceInput } from '../../src/features/evidence/qa/evidence-retrieval.service';
import type { RetrievedChunk } from '../../src/features/evidence/qa/types/retrieved-chunk.type';
import type { UserRole } from '../../src/shared/enums/user-role.enum';

/**
 * Which retrieval path a case is scored under. `'single-shot'` is the unchanged one-query
 * `EvidenceRetrievalService.retrieve` path; `'agentic'` runs `AgenticRetrievalService
 * .gatherEvidence` instead, letting the model iterate. Named identically to
 * `AnswerQuestionInput.retrievalStrategy` (`src/workflows/types.ts`) but kept as its own local
 * union rather than imported from there — that file sits behind the workflow determinism fence and
 * this module has no business depending on it.
 */
export type EvalRetrievalStrategy = 'single-shot' | 'agentic';

export const EVAL_RETRIEVAL_STRATEGIES: readonly EvalRetrievalStrategy[] = [
  'single-shot',
  'agentic',
];

export interface RetrievalStrategyResult {
  readonly chunks: readonly RetrievedChunk[];
  /** Agentic-only: `GatherEvidenceResult.iterations`. `undefined` for `'single-shot'`, which makes
   * exactly one retrieval call and has no turn count to report. */
  readonly turns?: number;
  /** Agentic-only: `GatherEvidenceResult.costUsd`. `undefined` for `'single-shot'`, which spends
   * nothing beyond the synthesis/grounding cost every strategy pays identically. */
  readonly costUsd?: number;
}

export interface GatherEvidenceForStrategyInput {
  readonly strategy: EvalRetrievalStrategy;
  readonly questionText: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly role: UserRole;
}

/** Seam for both `eval/run.ts` and a unit test — real callers pass the DI-resolved
 * `EvidenceRetrievalService.retrieve`/`AgenticRetrievalService.gatherEvidence`; a unit test passes
 * fakes instead of booting the whole Nest app, the same pattern `retrieval-comparison.ts`'s
 * `search` seam uses for `searchByMode`. */
export interface GatherEvidenceForStrategyDeps {
  readonly retrieveEvidence: (input: RetrieveEvidenceInput) => Promise<RetrievedChunk[]>;
  readonly gatherEvidence: (input: GatherEvidenceInput) => Promise<GatherEvidenceResult>;
}

/**
 * Picks the retrieval call for `input.strategy` and normalizes both paths down to
 * `RetrievalStrategyResult` — `chunks` flows to the unchanged synthesis/grounding steps
 * identically regardless of which strategy produced it; `turns`/`costUsd` are agentic-only and stay
 * `undefined` on the single-shot path, matching `RetrievalStrategyResult`'s own doc comment.
 */
export async function gatherEvidenceForStrategy(
  input: GatherEvidenceForStrategyInput,
  deps: GatherEvidenceForStrategyDeps,
): Promise<RetrievalStrategyResult> {
  if (input.strategy === 'single-shot') {
    const chunks = await deps.retrieveEvidence({
      questionText: input.questionText,
      tenantId: input.tenantId,
    });
    return { chunks };
  }

  const result = await deps.gatherEvidence({
    questionText: input.questionText,
    context: { tenantId: input.tenantId, actorId: input.actorId, role: input.role },
  });
  return { chunks: result.chunks, turns: result.iterations, costUsd: result.costUsd };
}
