import {
  buildNumericCase,
  periodPhrase,
  type NumericCaseSource,
} from '../../../scripts/public-corpus/lib/build-numeric-case';
import type { XbrlConcept } from '../../../scripts/public-corpus/lib/xbrl-concepts';

const CONCEPT: XbrlConcept = {
  taxonomy: 'us-gaap',
  name: 'Revenues',
  label: 'Total revenues',
  measureSlug: 'total_revenues',
  valueType: 'currency',
  unit: 'USD',
};

function buildSource(overrides: Partial<NumericCaseSource> = {}): NumericCaseSource {
  return {
    registrant: 'Prologis',
    concept: CONCEPT,
    form: '10-K',
    filingDate: '2025-02-01',
    accession: '0001045609-25-000001',
    start: '2024-01-01',
    end: '2024-12-31',
    val: 1234567,
    unit: 'USD',
    scale: 1,
    matchedText: '1,234,567',
    labelMatched: 'Total revenues',
    expectedLocators: [{ kind: 'text-block', file: 'prologis/10k.htm', blockIndex: 3 }],
    ...overrides,
  };
}

describe('periodPhrase', () => {
  it('is built from start/end only — a duration fact', () => {
    expect(periodPhrase('2024-01-01', '2024-12-31')).toBe('period from 2024-01-01 to 2024-12-31');
  });

  it('is built from end only for an instant fact (no start)', () => {
    expect(periodPhrase(null, '2024-12-31')).toBe('period ended 2024-12-31');
  });
});

describe('buildNumericCase', () => {
  it('rotates the question template by index', () => {
    const source = buildSource();
    const questions = [0, 1, 2, 3].map(
      (index) =>
        buildNumericCase(`num-00${index + 1}`, index, source, { authoringClass: 'numeric' })
          .question,
    );

    expect(questions[0]).toBe(
      "What was Prologis's Total revenues for the period from 2024-01-01 to 2024-12-31?",
    );
    expect(questions[1]).toBe(
      "According to Prologis's 10-K filed 2025-02-01, what Total revenues did it report for period from 2024-01-01 to 2024-12-31?",
    );
    expect(questions[2]).toBe(
      "State Prologis's Total revenues as reported for period from 2024-01-01 to 2024-12-31.",
    );
    // index 3 rotates back to template 0.
    expect(questions[3]).toBe(questions[0]);
  });

  it('sets expectedAnswerContains to exactly the matched text', () => {
    const evalCase = buildNumericCase('num-001', 0, buildSource(), { authoringClass: 'numeric' });

    expect(evalCase.expectedAnswerContains).toEqual(['1,234,567']);
    expect(evalCase.expectedLocators).toEqual(buildSource().expectedLocators);
    expect(evalCase.category).toBe('answerable');
    expect(evalCase.expectedOutcome).toBe('answer');
  });

  it('carries xbrl authoring metadata naming the concept and accession', () => {
    const evalCase = buildNumericCase('num-001', 0, buildSource(), { authoringClass: 'numeric' });

    expect(evalCase.authoring).toEqual({
      method: 'xbrl',
      class: 'numeric',
      source: 'Revenues@0001045609-25-000001',
    });
  });

  it('marks the entity-disambiguation class and notes the distractor', () => {
    const evalCase = buildNumericCase('dis-001', 0, buildSource(), {
      authoringClass: 'entity-disambiguation',
      distractorRegistrant: 'Simon Property Group',
    });

    expect(evalCase.authoring?.class).toBe('entity-disambiguation');
    expect(evalCase.notes).toContain('distractor=Simon Property Group');
  });

  it('notes carry concept, accession, period, val, unit, scale and labelMatched', () => {
    const evalCase = buildNumericCase('num-001', 0, buildSource(), { authoringClass: 'numeric' });

    expect(evalCase.notes).toContain('concept=Revenues');
    expect(evalCase.notes).toContain('accession=0001045609-25-000001');
    expect(evalCase.notes).toContain('start=2024-01-01');
    expect(evalCase.notes).toContain('end=2024-12-31');
    expect(evalCase.notes).toContain('val=1234567');
    expect(evalCase.notes).toContain('unit=USD');
    expect(evalCase.notes).toContain('scale=1');
    expect(evalCase.notes).toContain('labelMatched="Total revenues"');
  });
});
