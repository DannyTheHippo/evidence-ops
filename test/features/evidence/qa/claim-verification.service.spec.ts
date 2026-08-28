import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { normalizeEntityName } from '../../../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { ClaimVerificationService } from '../../../../src/features/evidence/qa/claim-verification.service';
import type { ConflictedFactGroup } from '../../../../src/features/evidence/conflicts/conflicts.service';
import { ConflictsService } from '../../../../src/features/evidence/conflicts/conflicts.service';
import { FactsService } from '../../../../src/features/evidence/facts/facts.service';
import { EvidenceRetrievalService } from '../../../../src/features/evidence/qa/evidence-retrieval.service';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import type { GroundingCellFact } from '../../../../src/features/evidence/qa/verify-claim';
import { MODEL_PROVIDER } from '../../../../src/providers/model/model-provider.interface';
import { FakeModelProvider } from '../../../../src/providers/model/fake-model.provider';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';

const PDF_LOCATOR: EvidenceLocator = { kind: 'pdf-page', extractorVersion: 'v1', page: 2 };
const SHA256_A = 'a'.repeat(64);

const CHUNK: RetrievedChunk = {
  chunkId: 'chunk-1',
  docVersionId: 'doc-v1',
  sha256: SHA256_A,
  text: 'Northgate Business Park traded in March 2025 at a cap rate of approximately 6.10%.',
  locator: PDF_LOCATOR,
};

const STATEMENT = 'Northgate Business Park traded at a cap rate of approximately 6.10%.';
const QUOTE = 'at a cap rate of approximately 6.10%';

interface Harness {
  readonly service: ClaimVerificationService;
  readonly modelProvider: FakeModelProvider;
  readonly evidenceRetrievalService: { retrieve: jest.Mock };
  readonly factsService: { findCellFacts: jest.Mock; findFactsForChunks: jest.Mock };
  readonly conflictsService: { findConflictedFactGroupsForChunks: jest.Mock };
}

async function buildHarness(): Promise<Harness> {
  const modelProvider = new FakeModelProvider();
  const evidenceRetrievalService = { retrieve: jest.fn().mockResolvedValue([CHUNK]) };
  const factsService = {
    findCellFacts: jest.fn().mockResolvedValue([]),
    findFactsForChunks: jest.fn().mockResolvedValue([]),
  };
  const conflictsService = {
    findConflictedFactGroupsForChunks: jest.fn().mockResolvedValue([]),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ClaimVerificationService,
      { provide: MODEL_PROVIDER, useValue: modelProvider },
      { provide: EvidenceRetrievalService, useValue: evidenceRetrievalService },
      { provide: FactsService, useValue: factsService },
      { provide: ConflictsService, useValue: conflictsService },
      { provide: AppLogger, useValue: getMockLogger() },
    ],
  }).compile();

  return {
    service: module.get(ClaimVerificationService),
    modelProvider,
    evidenceRetrievalService,
    factsService,
    conflictsService,
  };
}

describe('ClaimVerificationService', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should short-circuit to no_evidence_retrieved and never call the model or load facts/conflicts when nothing is retrieved', async () => {
    const harness = await buildHarness();
    harness.evidenceRetrievalService.retrieve.mockResolvedValueOnce([]);

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results).toEqual([{ claimIndex: 0, verdict: 'no_evidence_retrieved' }]);
    expect(harness.modelProvider.calls).toHaveLength(0);
    expect(harness.factsService.findCellFacts).not.toHaveBeenCalled();
    expect(harness.conflictsService.findConflictedFactGroupsForChunks).not.toHaveBeenCalled();
  });

  it('should return not_grounded with no reasonCode or citations when the model abstains', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({ output: { supported: false } });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results).toEqual([{ claimIndex: 0, verdict: 'not_grounded' }]);
    expect(harness.modelProvider.calls).toHaveLength(1);
    expect(harness.modelProvider.calls[0].taskClass).toBe('claim_verification');
    expect(harness.modelProvider.calls[0].maxTokens).toBe(4096);
    expect(harness.modelProvider.calls[0].maxCostUsd).toBe(0.25);
    expect(harness.modelProvider.calls[0].tenantId).toBe('tenant-1');
  });

  it('should return not_grounded with the failing check kind as reasonCode, and never surface the free-text drop reason, when a citation fails verification', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({
      output: {
        supported: true,
        citations: [{ candidateIndex: 0, quote: 'a quote never present in the cited chunk' }],
      },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results).toEqual([
      { claimIndex: 0, verdict: 'not_grounded', reasonCode: 'quote-not-found' },
    ]);
    expect(JSON.stringify(result)).not.toContain('does not appear in the cited chunk');
  });

  it('should return grounded with server-resolved citations for a surviving claim', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 0, quote: QUOTE }] },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results).toEqual([
      {
        claimIndex: 0,
        verdict: 'grounded',
        citations: [
          {
            chunkId: CHUNK.chunkId,
            docVersionId: CHUNK.docVersionId,
            sha256: CHUNK.sha256,
            locator: CHUNK.locator,
            quote: QUOTE,
          },
        ],
      },
    ]);
  });

  it('should return conflicting_evidence when a surviving claim touches a conflicted fact key', async () => {
    const harness = await buildHarness();
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const cellFacts: GroundingCellFact[] = [
      {
        chunkId: CHUNK.chunkId,
        factKey,
        value: { amount: 6.1, unit: 'percent' },
        locator: PDF_LOCATOR,
      },
    ];
    const conflictGroups: ConflictedFactGroup[] = [
      {
        conflictId: 'conflict-1',
        factKey,
        values: [
          { value: 6.1, unit: 'percent', sourceChunkId: CHUNK.chunkId },
          { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
        ],
      },
    ];
    harness.factsService.findCellFacts.mockResolvedValueOnce(cellFacts);
    harness.conflictsService.findConflictedFactGroupsForChunks.mockResolvedValueOnce(
      conflictGroups,
    );
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 0, quote: QUOTE }] },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results[0].verdict).toBe('conflicting_evidence');
    expect(result.results[0].citations).toEqual([
      {
        chunkId: CHUNK.chunkId,
        docVersionId: CHUNK.docVersionId,
        sha256: CHUNK.sha256,
        locator: CHUNK.locator,
        quote: QUOTE,
      },
    ]);
  });

  it('should return conflicting_evidence for a claim resting on a conflicted fact extracted from prose, with no cell facts involved', async () => {
    const harness = await buildHarness();
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const conflictGroups: ConflictedFactGroup[] = [
      {
        conflictId: 'conflict-1',
        factKey,
        values: [
          { value: 6.1, unit: 'percent', sourceChunkId: CHUNK.chunkId },
          { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
        ],
      },
    ];
    // No `findCellFacts` result: this fact only surfaces through `findFactsForChunks`, the
    // unfiltered lookup — proving the downgrade no longer depends on the fact being `xlsx-cell`.
    harness.factsService.findFactsForChunks.mockResolvedValueOnce([
      { chunkId: CHUNK.chunkId, factKey, value: { amount: 6.1, unit: 'percent' } },
    ]);
    harness.conflictsService.findConflictedFactGroupsForChunks.mockResolvedValueOnce(
      conflictGroups,
    );
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 0, quote: QUOTE }] },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results[0].verdict).toBe('conflicting_evidence');
    expect(harness.factsService.findFactsForChunks).toHaveBeenCalledWith(
      [CHUNK.chunkId],
      'tenant-1',
    );
  });

  it('should NOT downgrade to conflicting_evidence when the conflicted fact on a cited chunk names an entity the claim does not state', async () => {
    const harness = await buildHarness();
    const factKey = { entity: 'Southgate Plaza', metric: 'cap_rate', period: '2025-03' };
    const conflictGroups: ConflictedFactGroup[] = [
      {
        conflictId: 'conflict-1',
        factKey,
        values: [
          { value: 6.1, unit: 'percent', sourceChunkId: CHUNK.chunkId },
          { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
        ],
      },
    ];
    // Same chunk, same value as the conflict — only the entity differs from what `STATEMENT` names,
    // so this must not attach.
    harness.factsService.findFactsForChunks.mockResolvedValueOnce([
      { chunkId: CHUNK.chunkId, factKey, value: { amount: 6.1, unit: 'percent' } },
    ]);
    harness.conflictsService.findConflictedFactGroupsForChunks.mockResolvedValueOnce(
      conflictGroups,
    );
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 0, quote: QUOTE }] },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results[0].verdict).toBe('grounded');
  });

  it('should throw when the model cites a candidateIndex outside the offered candidates', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 3, quote: QUOTE }] },
    });

    await expect(
      harness.service.verifyClaims({ claims: [STATEMENT], tenantId: 'tenant-1' }),
    ).rejects.toThrow(/candidate index 3/);
  });

  it('should propagate a model provider failure rather than emitting a verdict', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueError(new Error('spend refused'));

    await expect(
      harness.service.verifyClaims({ claims: [STATEMENT], tenantId: 'tenant-1' }),
    ).rejects.toThrow('spend refused');
  });
});

// `findProseTouchedFactKeys` decides whether a fact's entity is named in a claim's statement by
// composing `normalizeEntityName` then `containsNormalizedToken` — the same fold `groupKey`/
// `factKeysMatch` key conflict grouping with, and the same whole-token containment `verifyClaim`'s
// own subject-entity check uses. Every case here runs the real `verifyClaims` pipeline end to end
// (never the pure helpers in isolation) specifically because the defect this class names lived in
// `findProseTouchedFactKeys`'s own reimplementation, not in `containsNormalizedToken` itself — a
// sweep over the helper alone would not have caught it.
describe('findProseTouchedFactKeys entity matching (normalization sweep)', () => {
  const withChar = (template: string, codePoint: number) =>
    template.replace('_', String.fromCodePoint(codePoint));

  // Every statement carries the literal `QUOTE` text so check 3 (`checkQuoteAlignment`) always
  // aligns regardless of which entity rendering precedes it — isolating the sweep to the entity
  // match findProseTouchedFactKeys performs, the only thing varying case to case.
  const statementFor = (entityRendering: string): string =>
    `${entityRendering} traded at a cap rate of approximately 6.10%.`;

  /** Re-arms one shared harness per call rather than building a fresh `TestingModule` per case —
   *  `mockResolvedValue` (not `...Once`), so a sweep of dozens of pairs stays well inside jest's
   *  per-test timeout. */
  async function verdictFor(
    harness: Harness,
    statement: string,
    storedEntity: string,
  ): Promise<string> {
    const factKey = { entity: storedEntity, metric: 'cap_rate', period: '2025-03' };
    harness.factsService.findFactsForChunks.mockResolvedValue([
      { chunkId: CHUNK.chunkId, factKey, value: { amount: 6.1, unit: 'percent' } },
    ]);
    harness.conflictsService.findConflictedFactGroupsForChunks.mockResolvedValue([
      {
        conflictId: 'conflict-1',
        factKey,
        values: [
          { value: 6.1, unit: 'percent', sourceChunkId: CHUNK.chunkId },
          { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
        ],
      },
    ]);
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 0, quote: QUOTE }] },
    });

    const result = await harness.service.verifyClaims({
      claims: [statement],
      tenantId: 'tenant-1',
    });
    return result.results[0].verdict;
  }

  it('should downgrade to conflicting_evidence across a claim statement rendered with every Unicode space-separator code point, including the ones NFKC leaves alone', async () => {
    const spaceSeparators: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const char = String.fromCodePoint(codePoint);
      if (/\p{Zs}/u.test(char)) {
        spaceSeparators.push(char);
      }
    }
    // Pinned, not sampled — mirrors `grounding-gate.service.spec.ts`'s identical sweep of the same
    // Unicode set: a revision that adds a space separator must fail here so the new code point is
    // checked against this normalization rather than reaching it unexamined.
    expect(spaceSeparators).toHaveLength(17);

    const harness = await buildHarness();
    for (const separator of spaceSeparators) {
      const statement = statementFor(`Acme${separator}${separator}Tower`);
      const verdict = await verdictFor(harness, statement, 'Acme Tower');
      expect([separator.codePointAt(0), verdict]).toEqual([
        separator.codePointAt(0),
        'conflicting_evidence',
      ]);
    }
  });

  it.each([
    ['fullwidth letters a PDF text layer emits', 'Ａｃｍｅ Ｔｏｗｅｒ', 'Acme Tower'],
    ['a compatibility ligature', 'Oﬃce Tower', 'Office Tower'],
    ['a no-break space', withChar('Acme_Tower', 0x00a0), 'Acme Tower'],
    ['an ideographic space', withChar('Acme_Tower', 0x3000), 'Acme Tower'],
    ['a narrow no-break space', withChar('Acme_Tower', 0x202f), 'Acme Tower'],
    ['an Ogham space mark, which NFKC leaves alone', withChar('Acme_Tower', 0x1680), 'Acme Tower'],
    ['mixed casing and a whitespace run', '  ACME \t Tower  ', 'Acme Tower'],
  ])(
    'should downgrade to conflicting_evidence when the claim statement carries %s and the stored fact key carries the plain-ASCII form',
    async (_description, rendered, storedEntity) => {
      const harness = await buildHarness();
      // The claim statement carries the rendering quirk; the stored `factKey.entity` is the plain
      // form the entity actually folds to — the realistic case named by the finding: an entity
      // arriving in a different Unicode encoding than the record it must still be found against.
      const verdict = await verdictFor(harness, statementFor(rendered), storedEntity);
      expect(verdict).toBe('conflicting_evidence');
    },
  );

  it.each([
    ['a no-break space in the stored entity only', withChar('Acme_Tower', 0x00a0)],
    ['fullwidth letters in the stored entity only', 'Ａｃｍｅ Ｔｏｗｅｒ'],
  ])(
    'should downgrade to conflicting_evidence when %s but the claim statement is plain ASCII',
    async (_description, storedEntity) => {
      const harness = await buildHarness();
      const verdict = await verdictFor(harness, statementFor('Acme Tower'), storedEntity);
      expect(verdict).toBe('conflicting_evidence');
    },
  );

  // The other half of the class: folding must not widen into matching an entity that is only a
  // substring of a different word — the failure direction `containsNormalizedToken`'s own doc
  // comment names (an attacker-controlled or merely coincidental entity name must not bind by
  // matching inside an unrelated longer word) — and a genuinely absent entity must not be found at
  // all. Every case must survive to a verdict at all (never `not_grounded`), so a claim that failed
  // to downgrade for the wrong reason cannot pass this assertion by accident.
  it.each([
    ['Acme', 'Acmeville'], // entity is a prefix of a different word
    ['Tower', 'Watchtower'], // entity is a suffix of a different word
    ['Acme Tower', 'Acme Towers'], // entity is a prefix of a longer phrase
    ['Acme Tower', 'Northgate Business Park'], // absent entirely
  ])(
    'should NOT downgrade to conflicting_evidence when the stored entity %p is not a whole token in %p',
    async (storedEntity, entityRendering) => {
      const harness = await buildHarness();
      const verdict = await verdictFor(harness, statementFor(entityRendering), storedEntity);
      expect(verdict).toBe('grounded');
    },
  );

  // The closing assertion for the class: agreement with an independently implemented whole-token
  // scan, over every fold variant and every "kept apart" pair exercised above, run through the real
  // `verifyClaims` pipeline rather than the helper `findProseTouchedFactKeys` now calls — which
  // cannot catch a wiring defect shared by both. The oracle mirrors
  // `scope-conflict-to-question.ts`'s `normalizedNameOccursInQuestion` — an ASCII `[a-z0-9]`
  // word-boundary walk, a different algorithm from `containsNormalizedToken`'s Unicode `\p{L}\p{N}`
  // regex lookaround. Scoped to the NFKC-foldable/whitespace/case domain this finding names: every
  // pool member folds to plain ASCII, so the two boundary algorithms are not expected to diverge
  // here (they would on a genuinely non-ASCII letter, e.g. an accented entity name, which is a
  // different class this sweep does not claim to close).
  function oracleOccursAsWholeToken(normalizedHaystack: string, normalizedNeedle: string): boolean {
    if (normalizedNeedle.length === 0) return false;
    const isWordChar = (char: string | undefined): boolean =>
      char !== undefined && /[a-z0-9]/.test(char);
    let searchFrom = 0;
    for (;;) {
      const index = normalizedHaystack.indexOf(normalizedNeedle, searchFrom);
      if (index === -1) return false;
      const before = normalizedHaystack[index - 1];
      const after = normalizedHaystack[index + normalizedNeedle.length];
      if (!isWordChar(before) && !isWordChar(after)) return true;
      searchFrom = index + 1;
    }
  }

  it('should agree with an independent whole-token scan, through the real pipeline, on every entity-rendering/stored-entity pair drawn from the sweep pool', async () => {
    const entityRenderingPool = [
      'Acme Tower',
      'Ａｃｍｅ Ｔｏｗｅｒ',
      withChar('Acme_Tower', 0x00a0),
      withChar('Acme_Tower', 0x3000),
      withChar('Acme_Tower', 0x202f),
      withChar('Acme_Tower', 0x1680),
      '  ACME \t Tower  ',
      'Acmeville',
      'Watchtower',
      'Acme Towers',
      'Northgate Business Park',
    ];
    const storedEntityPool = ['Acme', 'Tower', 'Acme Tower', 'Northgate Business Park'];

    const harness = await buildHarness();
    for (const entityRendering of entityRenderingPool) {
      for (const storedEntity of storedEntityPool) {
        const normalizedStatement = normalizeEntityName(statementFor(entityRendering));
        const normalizedEntity = normalizeEntityName(storedEntity);
        const expectMatch = oracleOccursAsWholeToken(normalizedStatement, normalizedEntity);
        const verdict = await verdictFor(harness, statementFor(entityRendering), storedEntity);
        expect([entityRendering, storedEntity, verdict]).toEqual([
          entityRendering,
          storedEntity,
          expectMatch ? 'conflicting_evidence' : 'grounded',
        ]);
      }
    }
  });
});
