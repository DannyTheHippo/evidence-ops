import {
  buildWorksheet,
  type WorksheetInput,
} from '../../../../scripts/experiments/verifier/build-worksheet';
import { VERIFIER_SHORTLIST_SIZE } from '../../../../scripts/experiments/verifier/worksheet-format';
import type { ClaimContext } from '../../../../scripts/experiments/verifier/types';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import { makeLocator, makeOutcome } from './verifier-fixtures';

function makeHit(index: number): RetrievedChunk {
  return {
    chunkId: `chunk-${index}`,
    docVersionId: 'version-1',
    sha256: 'a'.repeat(64),
    text: `evidence passage ${index}`,
    locator: makeLocator(index),
  };
}

function makeInput(overrides: Partial<WorksheetInput> = {}): WorksheetInput {
  const sampled = [
    makeOutcome({
      claimId: 'c002',
      statement: 'The property was refinanced in March 2024.',
      verdict: 'not_grounded',
      reasonCode: 'quote-not-found',
      sourceFilename: 'om.pdf',
    }),
  ];
  const contexts: ClaimContext[] = [
    {
      claimId: 'c002',
      hits: Array.from({ length: VERIFIER_SHORTLIST_SIZE + 2 }, (_, index) => makeHit(index + 1)),
      filenameByDocVersionId: { 'version-1': 'om.pdf' },
    },
  ];

  return {
    runId: 'run-1',
    gitSha: 'abc123',
    tenantId: 'eval',
    totalClaims: 100,
    breakdown: {
      grounded: 75,
      not_grounded: 20,
      no_evidence_retrieved: 2,
      conflicting_evidence: 3,
    },
    sample: { seed: 1729, populationSize: 22, claimIds: ['c002'] },
    sampled,
    contexts,
    corpusFilenames: ['om.pdf', 'rent-roll.xlsx'],
    ...overrides,
  };
}

describe('buildWorksheet', () => {
  it('carries the claim, the verdict, the reason code and the source file', () => {
    const worksheet = buildWorksheet(makeInput());

    expect(worksheet).toContain('### claim c002');
    expect(worksheet).toContain('The property was refinanced in March 2024.');
    expect(worksheet).toContain('- **Verdict:** not_grounded');
    expect(worksheet).toContain('- **Reason code:** quote-not-found');
    expect(worksheet).toContain('- **Drafted from:** om.pdf');
  });

  it('leaves the adjudication field empty for a person to fill', () => {
    const worksheet = buildWorksheet(makeInput());

    expect(worksheet).toContain('- **Adjudication:** \n');
    expect(worksheet).toContain('- **Note:** ');
    expect(worksheet).toContain('`correct_catch`');
    expect(worksheet).toContain('`false_catch`');
  });

  it('states which hits the verifier saw and which it did not', () => {
    const worksheet = buildWorksheet(makeInput());

    expect(worksheet).toContain('evidence passage 1');
    expect(worksheet).toContain(`${VERIFIER_SHORTLIST_SIZE}. \`om.pdf\``);
    expect(worksheet.match(/\(shown to verifier\)/g)).toHaveLength(VERIFIER_SHORTLIST_SIZE);
    expect(worksheet.match(/\(not shown to verifier\)/g)).toHaveLength(2);
  });

  it('names every corpus file, since a false catch can rest on one retrieval never returned', () => {
    const worksheet = buildWorksheet(makeInput());

    expect(worksheet).toContain('`om.pdf`, `rent-roll.xlsx`');
  });

  it('reports the run totals and the sampling seed in the header', () => {
    const worksheet = buildWorksheet(makeInput());

    expect(worksheet).toContain('- Claims drafted: 100');
    expect(worksheet).toContain('- Gate failures (not_grounded + no_evidence_retrieved): 22');
    expect(worksheet).toContain('- Sampled for adjudication: 1 of 22 (seed 1729)');
  });

  it('says so plainly when retrieval returned nothing for a claim', () => {
    const worksheet = buildWorksheet(makeInput({ contexts: [] }));

    expect(worksheet).toContain('_Retrieval returned nothing for this claim._');
  });

  it('renders the citations the gate accepted when there are any', () => {
    const worksheet = buildWorksheet(
      makeInput({
        sampled: [
          makeOutcome({
            claimId: 'c002',
            verdict: 'not_grounded',
            citations: [
              {
                chunkId: 'chunk-1',
                docVersionId: 'version-1',
                sha256: 'a'.repeat(64),
                locator: makeLocator(4),
                quote: 'a quote the gate kept',
              },
            ],
          }),
        ],
      }),
    );

    expect(worksheet).toContain('**Citations the gate accepted**');
    expect(worksheet).toContain('> a quote the gate kept');
  });

  it('says none when the gate accepted no citation', () => {
    expect(buildWorksheet(makeInput())).toContain('**Citations the gate accepted:** none');
  });
});
