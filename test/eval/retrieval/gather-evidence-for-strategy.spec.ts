import type { GatherEvidenceResult } from '../../../src/features/evidence/qa/agentic-retrieval.service';
import type { RetrievedChunk } from '../../../src/features/evidence/qa/types/retrieved-chunk.type';
import { UserRole } from '../../../src/shared/enums/user-role.enum';
import {
  EVAL_RETRIEVAL_STRATEGIES,
  gatherEvidenceForStrategy,
} from '../../../eval/retrieval/gather-evidence-for-strategy';

function makeChunk(chunkId: string): RetrievedChunk {
  return {
    chunkId,
    docVersionId: 'docver-1',
    sha256: 'sha-1',
    text: 'chunk text',
    locator: { kind: 'pdf-page', page: 1, extractorVersion: 'test' },
  };
}

describe('gatherEvidenceForStrategy', () => {
  it('should call retrieveEvidence and report no turns/cost for the single-shot strategy', async () => {
    const chunks = [makeChunk('chunk-1')];
    const retrieveEvidence = jest.fn().mockResolvedValue(chunks);
    const gatherEvidence = jest.fn();

    const result = await gatherEvidenceForStrategy(
      {
        strategy: 'single-shot',
        questionText: 'What was the sale price?',
        tenantId: 'eval',
        actorId: 'eval-actor',
        role: UserRole.Member,
      },
      { retrieveEvidence, gatherEvidence },
    );

    expect(retrieveEvidence).toHaveBeenCalledWith({
      questionText: 'What was the sale price?',
      tenantId: 'eval',
    });
    expect(gatherEvidence).not.toHaveBeenCalled();
    expect(result).toEqual({ chunks });
  });

  it('should call gatherEvidence with a server-derived context and surface turns/cost for the agentic strategy', async () => {
    const gatherResult: GatherEvidenceResult = {
      chunks: [makeChunk('chunk-2')],
      iterations: 3,
      costUsd: 0.042,
      terminationReason: 'no-tool-call',
    };
    const retrieveEvidence = jest.fn();
    const gatherEvidence = jest.fn().mockResolvedValue(gatherResult);

    const result = await gatherEvidenceForStrategy(
      {
        strategy: 'agentic',
        questionText: 'What was the sale price?',
        tenantId: 'eval',
        actorId: 'eval-actor',
        role: UserRole.Member,
      },
      { retrieveEvidence, gatherEvidence },
    );

    expect(retrieveEvidence).not.toHaveBeenCalled();
    expect(gatherEvidence).toHaveBeenCalledWith({
      questionText: 'What was the sale price?',
      context: { tenantId: 'eval', actorId: 'eval-actor', role: UserRole.Member },
    });
    expect(result).toEqual({
      chunks: gatherResult.chunks,
      turns: 3,
      costUsd: 0.042,
    });
  });

  it('should list exactly the two eval retrieval strategies, single-shot first', () => {
    expect(EVAL_RETRIEVAL_STRATEGIES).toEqual(['single-shot', 'agentic']);
  });
});
