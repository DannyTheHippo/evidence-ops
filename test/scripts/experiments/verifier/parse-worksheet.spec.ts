import { parseWorksheet } from '../../../../scripts/experiments/verifier/parse-worksheet';

function section(claimId: string, adjudication: string, note = ''): string {
  return [
    `### claim ${claimId}`,
    '',
    '- **Verdict:** not_grounded',
    '',
    `- **Adjudication:** ${adjudication}`,
    `- **Note:** ${note}`,
    '',
  ].join('\n');
}

describe('parseWorksheet', () => {
  it('reads a filled adjudication and its note', () => {
    const parsed = parseWorksheet(
      section('c001', 'correct_catch', 'nothing in the corpus says this'),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        claimId: 'c001',
        adjudication: 'correct_catch',
        note: 'nothing in the corpus says this',
      },
    ]);
  });

  it('accepts a value a person wrapped in backticks', () => {
    const parsed = parseWorksheet(section('c001', '`false_catch`'));

    expect(parsed.rows[0].adjudication).toBe('false_catch');
  });

  it('reports an unfilled row as unfilled, not as an error', () => {
    const parsed = parseWorksheet(section('c001', '   '));

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([{ claimId: 'c001', adjudication: null, note: '' }]);
  });

  it('treats a section with no adjudication line at all as unfilled', () => {
    const parsed = parseWorksheet(
      ['### claim c001', '', '- **Verdict:** not_grounded', ''].join('\n'),
    );

    expect(parsed.rows).toEqual([{ claimId: 'c001', adjudication: null, note: '' }]);
  });

  it('rejects a value outside the two buckets without guessing one', () => {
    const parsed = parseWorksheet(section('c001', 'probably fine'));

    expect(parsed.rows[0].adjudication).toBeNull();
    expect(parsed.errors).toEqual([
      {
        claimId: 'c001',
        rawValue: 'probably fine',
        message: "claim c001: 'probably fine' is not correct_catch or false_catch",
      },
    ]);
  });

  it('rejects a repeated claim section', () => {
    const parsed = parseWorksheet(
      `${section('c001', 'correct_catch')}\n${section('c001', 'false_catch')}`,
    );

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors[0].message).toContain('appears in more than one section');
  });

  it('rejects a second adjudication line inside one section', () => {
    const markdown = [
      '### claim c001',
      '- **Adjudication:** correct_catch',
      '- **Adjudication:** false_catch',
      '',
    ].join('\n');

    const parsed = parseWorksheet(markdown);

    expect(parsed.rows[0].adjudication).toBe('correct_catch');
    expect(parsed.errors[0].message).toContain('more than one adjudication line');
  });

  it('ignores adjudication text outside any claim section', () => {
    const markdown = ['- **Adjudication:** correct_catch', '', '# heading'].join('\n');

    expect(parseWorksheet(markdown)).toEqual({ rows: [], errors: [] });
  });

  it('reads every section of a multi-claim worksheet', () => {
    const parsed = parseWorksheet(
      [section('c001', 'correct_catch'), section('c007', 'false_catch'), section('c012', '')].join(
        '\n',
      ),
    );

    expect(parsed.rows.map((row) => [row.claimId, row.adjudication])).toEqual([
      ['c001', 'correct_catch'],
      ['c007', 'false_catch'],
      ['c012', null],
    ]);
  });
});
