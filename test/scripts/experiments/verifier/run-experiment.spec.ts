import {
  CLAIMS_ARTEFACT,
  RUN_ARTEFACT,
  VERDICTS_ARTEFACT,
  WORKSHEET_ARTEFACT,
  runExperiment,
  type RunExperimentDeps,
  type RunExperimentOptions,
  type RunRecord,
} from '../../../../scripts/experiments/verifier/run-experiment';
import type {
  ClaimVerdict,
  VerifyClaimsResult,
} from '../../../../src/features/evidence/qa/contracts/verify-claims.contract';
import { makeChunk, makeDocument, makeLocator } from './verifier-fixtures';

/**
 * Drives the whole run against fabricated drafting, verification and retrieval — no Nest container,
 * no Mongo, no model call. The `verdicts` map decides each statement's verdict by its text, so a
 * spec can compose any mix of outcomes.
 */
function makeDeps(
  statementsByFile: Readonly<Record<string, readonly string[]>>,
  verdicts: Readonly<Record<string, ClaimVerdict>>,
): {
  deps: RunExperimentDeps;
  artefacts: Map<string, string>;
  calls: string[];
  batchSizes: number[];
} {
  const artefacts = new Map<string, string>();
  const calls: string[] = [];
  const batchSizes: number[] = [];

  const deps: RunExperimentDeps = {
    draftForDocument: (document) => {
      calls.push(`draft:${document.filename}`);
      return Promise.resolve(statementsByFile[document.filename] ?? []);
    },
    verifyBatch: (statements): Promise<VerifyClaimsResult> => {
      calls.push('verify');
      batchSizes.push(statements.length);
      return Promise.resolve({
        advisory: 'advisory text',
        results: statements.map((statement, claimIndex) => ({
          claimIndex,
          verdict: verdicts[statement] ?? 'grounded',
        })),
      });
    },
    retrieveContext: (statement) => {
      calls.push('retrieve');
      return Promise.resolve([
        {
          chunkId: `chunk-for-${statement}`,
          docVersionId: 'version-1',
          sha256: 'a'.repeat(64),
          text: `passage behind ${statement}`,
          locator: makeLocator(1),
        },
      ]);
    },
    writeArtefact: (filename, content) => {
      calls.push(`write:${filename}`);
      artefacts.set(filename, content);
      return Promise.resolve();
    },
    log: () => undefined,
  };

  return { deps, artefacts, calls, batchSizes };
}

const options: RunExperimentOptions = {
  runId: 'run-1',
  gitSha: 'abc123',
  tenantId: 'eval',
  maxBatchSize: 10,
  seed: 1729,
  filenameByDocVersionId: { 'version-1': 'om.pdf' },
};

const documents = [
  makeDocument({
    filename: 'om.pdf',
    documentVersionId: 'version-1',
    chunks: [makeChunk({ chunkId: 'chunk-1' })],
  }),
  makeDocument({
    filename: 'rent-roll.xlsx',
    documentVersionId: 'version-2',
    chunks: [makeChunk({ chunkId: 'chunk-2' })],
  }),
];

describe('runExperiment', () => {
  it('drafts, verifies, samples and writes every artefact', async () => {
    const { deps, artefacts } = makeDeps(
      {
        'om.pdf': ['claim one', 'claim two'],
        'rent-roll.xlsx': ['claim three'],
      },
      { 'claim two': 'not_grounded', 'claim three': 'no_evidence_retrieved' },
    );

    const record = await runExperiment(documents, deps, options);

    expect(record.totalClaims).toBe(3);
    expect(record.breakdown).toEqual({
      grounded: 1,
      not_grounded: 1,
      no_evidence_retrieved: 1,
      conflicting_evidence: 0,
    });
    expect(record.gateFailureCount).toBe(2);
    expect(record.bar1).toEqual({ threshold: 0.2, observed: 2 / 3, met: true });
    expect(record.sample.claimIds).toEqual(['c002', 'c003']);
    expect([...artefacts.keys()].sort()).toEqual(
      [CLAIMS_ARTEFACT, RUN_ARTEFACT, VERDICTS_ARTEFACT, WORKSHEET_ARTEFACT].sort(),
    );
  });

  it('persists the drafted claims before any verification runs', async () => {
    const { deps, calls } = makeDeps({ 'om.pdf': ['claim one'], 'rent-roll.xlsx': [] }, {});

    await runExperiment(documents, deps, options);

    expect(calls.indexOf(`write:${CLAIMS_ARTEFACT}`)).toBeLessThan(calls.indexOf('verify'));
  });

  it('rewrites the verdicts artefact after every batch so a crash leaves the finished ones', async () => {
    const statements = Array.from({ length: 25 }, (_, index) => `claim ${index + 1}`);
    const { deps, calls, batchSizes, artefacts } = makeDeps(
      { 'om.pdf': statements, 'rent-roll.xlsx': [] },
      {},
    );

    await runExperiment(documents, deps, options);

    expect(batchSizes).toEqual([10, 10, 5]);
    expect(calls.filter((call) => call === `write:${VERDICTS_ARTEFACT}`)).toHaveLength(3);
    expect(JSON.parse(artefacts.get(VERDICTS_ARTEFACT) ?? '')).toMatchObject({
      advisory: 'advisory text',
    });
  });

  it('drops a statement that repeats one already drafted, whatever its spacing or case', async () => {
    const { deps, artefacts } = makeDeps(
      {
        'om.pdf': ['claim one', 'Claim   One'],
        'rent-roll.xlsx': ['claim one'],
      },
      {},
    );

    const record = await runExperiment(documents, deps, options);

    expect(record.totalClaims).toBe(1);
    expect(record.duplicatesDropped).toBe(2);
    const claims = JSON.parse(artefacts.get(CLAIMS_ARTEFACT) ?? '') as {
      claims: { claimId: string; sourceFilename: string }[];
    };
    expect(claims.claims).toHaveLength(1);
    expect(claims.claims[0]).toMatchObject({ claimId: 'c001', sourceFilename: 'om.pdf' });
  });

  it('numbers claims across documents in drafting order', async () => {
    const { deps, artefacts } = makeDeps(
      { 'om.pdf': ['claim one', 'claim two'], 'rent-roll.xlsx': ['claim three'] },
      {},
    );

    await runExperiment(documents, deps, options);

    const claims = JSON.parse(artefacts.get(CLAIMS_ARTEFACT) ?? '') as {
      claims: { claimId: string; sourceFilename: string; draftPass: number }[];
    };
    expect(
      claims.claims.map((claim) => [claim.claimId, claim.sourceFilename, claim.draftPass]),
    ).toEqual([
      ['c001', 'om.pdf', 0],
      ['c002', 'om.pdf', 0],
      ['c003', 'rent-roll.xlsx', 1],
    ]);
  });

  it('puts only the sampled gate failures on the worksheet', async () => {
    const { deps, artefacts } = makeDeps(
      {
        'om.pdf': ['claim one', 'claim two'],
        'rent-roll.xlsx': ['claim three'],
      },
      { 'claim two': 'not_grounded', 'claim three': 'conflicting_evidence' },
    );

    await runExperiment(documents, deps, options);

    const worksheet = artefacts.get(WORKSHEET_ARTEFACT) ?? '';
    expect(worksheet).toContain('### claim c002');
    expect(worksheet).not.toContain('### claim c001');
    expect(worksheet).not.toContain('### claim c003');
    expect(worksheet).toContain('passage behind claim two');
    // The hit resolves to a filename, not to `unknown file`: an adjudicator deciding whether the
    // evidence exists needs to know which file each excerpt came from.
    expect(worksheet).toContain('1. `om.pdf` — page 1');
    expect(worksheet).not.toContain('unknown file');
  });

  it('retrieves worksheet context only for the sampled claims', async () => {
    const { deps, calls } = makeDeps(
      { 'om.pdf': ['claim one', 'claim two'], 'rent-roll.xlsx': [] },
      { 'claim two': 'not_grounded' },
    );

    await runExperiment(documents, deps, options);

    expect(calls.filter((call) => call === 'retrieve')).toHaveLength(1);
  });

  it('writes a run record the summary command can read back', async () => {
    const { deps, artefacts } = makeDeps(
      { 'om.pdf': ['claim one'], 'rent-roll.xlsx': [] },
      { 'claim one': 'not_grounded' },
    );

    await runExperiment(documents, deps, options);

    const record = JSON.parse(artefacts.get(RUN_ARTEFACT) ?? '') as RunRecord;
    expect(record).toMatchObject({
      runId: 'run-1',
      gitSha: 'abc123',
      tenantId: 'eval',
      totalClaims: 1,
      sample: { seed: 1729, populationSize: 1, claimIds: ['c001'] },
    });
    expect(Date.parse(record.generatedAt)).not.toBeNaN();
  });

  it('refuses a run whose drafting pass produced nothing', async () => {
    const { deps } = makeDeps({ 'om.pdf': [], 'rent-roll.xlsx': [] }, {});

    await expect(runExperiment(documents, deps, options)).rejects.toThrow('produced no claims');
  });
});
