import { buildWorksheet } from '../../../../scripts/experiments/verifier/build-worksheet';
import { parseWorksheet } from '../../../../scripts/experiments/verifier/parse-worksheet';
import {
  renderSummaryMarkdown,
  summarizeExperiment,
  type SummaryInput,
} from '../../../../scripts/experiments/verifier/summarize-experiment';
import type {
  Adjudication,
  AdjudicationRow,
  VerdictBreakdown,
} from '../../../../scripts/experiments/verifier/types';
import { makeOutcomes } from './verifier-fixtures';

function rows(entries: readonly (readonly [string, Adjudication | null])[]): AdjudicationRow[] {
  return entries.map(([claimId, adjudication]) => ({ claimId, adjudication, note: '' }));
}

function makeInput(overrides: Partial<SummaryInput> = {}): SummaryInput {
  const breakdown: VerdictBreakdown = {
    grounded: 78,
    not_grounded: 20,
    no_evidence_retrieved: 2,
    conflicting_evidence: 0,
  };
  return {
    runId: 'run-1',
    gitSha: 'abc123',
    tenantId: 'eval',
    totalClaims: 100,
    breakdown,
    sample: { seed: 1729, populationSize: 22, claimIds: ['c001', 'c002'] },
    rows: rows([
      ['c001', 'correct_catch'],
      ['c002', 'false_catch'],
    ]),
    ...overrides,
  };
}

describe('summarizeExperiment', () => {
  it('computes both pre-registered rates from a mixed adjudication', () => {
    const claimIds = Array.from(
      { length: 10 },
      (_, index) => `c${String(index + 1).padStart(3, '0')}`,
    );
    const summary = summarizeExperiment(
      makeInput({
        sample: { seed: 1729, populationSize: 22, claimIds },
        rows: rows(
          claimIds.map((claimId, index) => [claimId, index < 7 ? 'correct_catch' : 'false_catch']),
        ),
      }),
    );

    expect(summary.gateFailureCount).toBe(22);
    expect(summary.bar1).toEqual({ threshold: 0.2, observed: 0.22, met: true });
    expect(summary.correctCatchCount).toBe(7);
    expect(summary.falseCatchCount).toBe(3);
    expect(summary.bar2).toEqual({ threshold: 0.7, observed: 0.7, met: true });
  });

  it('misses bar 2 when most catches were the gate failing to find evidence', () => {
    const claimIds = ['c001', 'c002', 'c003', 'c004'];
    const summary = summarizeExperiment(
      makeInput({
        sample: { seed: 1729, populationSize: 4, claimIds },
        rows: rows([
          ['c001', 'correct_catch'],
          ['c002', 'false_catch'],
          ['c003', 'false_catch'],
          ['c004', 'false_catch'],
        ]),
      }),
    );

    expect(summary.bar2).toEqual({ threshold: 0.7, observed: 0.25, met: false });
  });

  it('misses bar 1 when the gate passes nearly everything', () => {
    const summary = summarizeExperiment(
      makeInput({
        breakdown: {
          grounded: 95,
          not_grounded: 4,
          no_evidence_retrieved: 1,
          conflicting_evidence: 0,
        },
      }),
    );

    expect(summary.bar1).toEqual({ threshold: 0.2, observed: 0.05, met: false });
  });

  it('counts conflicting_evidence in the denominator but never as a gate failure', () => {
    const summary = summarizeExperiment(
      makeInput({
        breakdown: {
          grounded: 70,
          not_grounded: 10,
          no_evidence_retrieved: 0,
          conflicting_evidence: 20,
        },
      }),
    );

    expect(summary.gateFailureCount).toBe(10);
    expect(summary.bar1.observed).toBeCloseTo(0.1, 10);
  });

  it('withholds bar 2 while any sampled claim is unadjudicated, and names them', () => {
    const summary = summarizeExperiment(
      makeInput({
        sample: { seed: 1729, populationSize: 22, claimIds: ['c001', 'c002', 'c003'] },
        rows: rows([
          ['c001', 'correct_catch'],
          ['c002', null],
        ]),
      }),
    );

    expect(summary.bar2).toBeNull();
    expect(summary.unfilledClaimIds).toEqual(['c002', 'c003']);
    expect(summary.bar1.met).toBe(true);
  });

  it('flags worksheet rows for claims that were never sampled', () => {
    const summary = summarizeExperiment(
      makeInput({
        rows: rows([
          ['c001', 'correct_catch'],
          ['c002', 'false_catch'],
          ['c099', 'correct_catch'],
        ]),
      }),
    );

    expect(summary.unknownClaimIds).toEqual(['c099']);
    expect(summary.correctCatchCount).toBe(1);
  });

  it('scores a worksheet built by the harness and filled by hand', () => {
    const failures = makeOutcomes(3, 'not_grounded');
    const worksheet = buildWorksheet({
      runId: 'run-1',
      gitSha: 'abc123',
      tenantId: 'eval',
      totalClaims: 10,
      breakdown: {
        grounded: 7,
        not_grounded: 3,
        no_evidence_retrieved: 0,
        conflicting_evidence: 0,
      },
      sample: { seed: 1729, populationSize: 3, claimIds: ['c001', 'c002', 'c003'] },
      sampled: failures,
      contexts: [],
      corpusFilenames: ['om.pdf'],
    });
    const verdicts: readonly Adjudication[] = ['correct_catch', 'correct_catch', 'false_catch'];
    let filled = 0;
    const handFilled = worksheet
      .split('\n')
      .map((line) =>
        line.startsWith('- **Adjudication:**') ? `- **Adjudication:** ${verdicts[filled++]}` : line,
      )
      .join('\n');

    const summary = summarizeExperiment(
      makeInput({
        totalClaims: 10,
        breakdown: {
          grounded: 7,
          not_grounded: 3,
          no_evidence_retrieved: 0,
          conflicting_evidence: 0,
        },
        sample: { seed: 1729, populationSize: 3, claimIds: ['c001', 'c002', 'c003'] },
        rows: parseWorksheet(handFilled).rows,
      }),
    );

    expect(summary.bar1).toEqual({ threshold: 0.2, observed: 0.3, met: true });
    expect(summary.bar2?.observed).toBeCloseTo(2 / 3, 10);
    expect(summary.bar2?.met).toBe(false);
  });
});

describe('renderSummaryMarkdown', () => {
  it('states each bar as met or missed against its pre-registered number', () => {
    const markdown = renderSummaryMarkdown(summarizeExperiment(makeInput()));

    expect(markdown).toContain('## Bar 1 — MET');
    expect(markdown).toContain('Minimum 20% of drafted claims fail the gate.');
    expect(markdown).toContain('Observed 22.0% against a minimum of 20.0%.');
    expect(markdown).toContain('## Bar 2 — MISSED');
    expect(markdown).toContain('Observed 50.0% against a minimum of 70.0%.');
  });

  it('reports every verdict count, not only the ones the bars use', () => {
    const markdown = renderSummaryMarkdown(summarizeExperiment(makeInput()));

    expect(markdown).toContain('- grounded: 78');
    expect(markdown).toContain('- not_grounded: 20');
    expect(markdown).toContain('- no_evidence_retrieved: 2');
    expect(markdown).toContain('- conflicting_evidence: 0');
  });

  it('reports no rate at all while the sample is unadjudicated', () => {
    const markdown = renderSummaryMarkdown(
      summarizeExperiment(makeInput({ rows: rows([['c001', 'correct_catch']]) })),
    );

    expect(markdown).toContain('## Bar 2 — NOT EVALUATED');
    expect(markdown).toContain('The sample is not fully adjudicated. No rate is reported.');
    expect(markdown).toContain('Unadjudicated claims: `c002`');
  });

  it('records the sampled claim ids so the draw is auditable', () => {
    const markdown = renderSummaryMarkdown(summarizeExperiment(makeInput()));

    expect(markdown).toContain('(seed 1729)');
    expect(markdown).toContain('Sampled claim ids: `c001`, `c002`');
  });
});
