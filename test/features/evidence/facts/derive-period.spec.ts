import {
  derivePeriodFromDateText,
  findStatedPeriods,
  findStatedPeriodSpans,
  parsePeriod,
  parsePeriodKey,
  periodsOverlap,
  UNDATED_PERIOD,
  UNPARSEABLE_PERIOD_PREFIX,
} from '../../../../src/features/evidence/facts/derive-period';

const MONTH_NAMES = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['may', 'may'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sep'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
];

const casings = (word: string): string[] => [
  word.toLowerCase(),
  word.toUpperCase(),
  word[0].toUpperCase() + word.slice(1).toLowerCase(),
];

describe('parsePeriod', () => {
  describe('the calendar forms it accepts', () => {
    // Every month, every spelling this module claims to read, every casing, in every phrase shape
    // — not a sample. A form that silently stops resolving is the failure this sweep exists to
    // catch, because an unresolved form does not throw, it just keys somewhere else.
    it.each(MONTH_NAMES.map((names, index) => [index + 1, names] as const))(
      'should resolve month %i from every accepted spelling, casing and phrase shape',
      (monthNumber, names) => {
        const expected = `2025-${String(monthNumber).padStart(2, '0')}`;
        const phrases = names.flatMap((name) =>
          casings(name).flatMap((cased) => [
            `${cased} 2025`,
            `${cased}, 2025`,
            `${cased}. 2025`,
            `${cased} 12, 2025`,
            `${cased} 1st, 2025`,
            `12 ${cased} 2025`,
            `12th of ${cased} 2025`,
            `closed in ${cased} 2025`,
          ]),
        );

        for (const phrase of phrases) {
          expect([phrase, derivePeriodFromDateText(phrase)]).toEqual([phrase, expected]);
        }
      },
    );

    it('should coarsen every ISO day of a month to that month, and pass an ISO month through', () => {
      for (let month = 1; month <= 12; month += 1) {
        const padded = String(month).padStart(2, '0');
        for (let day = 1; day <= 28; day += 1) {
          const text = `2025-${padded}-${String(day).padStart(2, '0')}`;
          expect([text, derivePeriodFromDateText(text)]).toEqual([text, `2025-${padded}`]);
        }
        expect(derivePeriodFromDateText(`2025-${padded}`)).toBe(`2025-${padded}`);
      }
    });

    it.each([
      ['Q1 2025', '2025-Q1'],
      ['q1 2025', '2025-Q1'],
      ['Q1-2025', '2025-Q1'],
      ['Q12025', '2025-Q1'],
      ['2025-Q2', '2025-Q2'],
      ['2025 Q3', '2025-Q3'],
      ['reported for Q4 2025', '2025-Q4'],
    ])('should resolve the quarter form %p to %p', (text, expected) => {
      expect(derivePeriodFromDateText(text)).toBe(expected);
    });

    it.each([
      ['FY2025', 'FY2025'],
      ['FY 2025', 'FY2025'],
      ['FY-2025', 'FY2025'],
      ['fy2025', 'FY2025'],
      ['restated for FY2024', 'FY2024'],
    ])('should resolve the fiscal-year form %p to %p', (text, expected) => {
      expect(derivePeriodFromDateText(text)).toBe(expected);
    });

    it('should read a bare year only when it is the entire field', () => {
      expect(parsePeriod('2025')).toEqual(
        expect.objectContaining({ granularity: 'year', key: '2025' }),
      );
      expect(parsePeriod('  2025  ').key).toBe('2025');
    });
  });

  describe('the forms it refuses', () => {
    // The refusal set, swept as a class rather than as the instances that prompted it. Each entry
    // must produce a key that is visibly a refusal, is not the unstated sentinel, and is not the
    // key of any other refusal.
    const REFUSED = [
      // Ambiguous between US and European day/month order — a reading either way is a guess.
      '03/14/2025',
      '14/03/2025',
      '2025/03/14',
      '03-14-2025',
      // Two-digit years: 25 is 2025 or 1925 with equal warrant.
      'Mar 25',
      'FY25',
      '25-03',
      // Not a calendar value, though the shape matches.
      '2025-02-30',
      '2025-13',
      '2025-00',
      'February 30, 2025',
      'April 31, 2025',
      // Not a month name.
      'Smarch 2025',
      'Sunday 2025',
      // A period the model does not represent.
      'H1 2025',
      'first half of 2025',
      'Q5 2025',
      // A year outside the plausible window is an identifier, not a period.
      '1899',
      '2100',
      // No date at all.
      'at closing',
      'as reported',
      'sold in 2019',
      'sold in 2024',
    ];

    it.each(REFUSED)('should refuse %p visibly rather than bucketing it with undated', (text) => {
      const period = parsePeriod(text);

      expect(period.granularity).toBe('unparseable');
      expect(period.key.startsWith(UNPARSEABLE_PERIOD_PREFIX)).toBe(true);
      expect(period.key).not.toBe(UNDATED_PERIOD);
      expect(period.range).toBeUndefined();
    });

    it('should give every refused text its own key, so two unreadable periods never conflict with each other', () => {
      const keys = REFUSED.map((text) => derivePeriodFromDateText(text));

      expect(new Set(keys).size).toBe(REFUSED.length);
    });

    it('should key a refusal stably across repeat calls and across casing and whitespace variants', () => {
      expect(derivePeriodFromDateText('at closing')).toBe(derivePeriodFromDateText('at closing'));
      expect(derivePeriodFromDateText('  AT   Closing ')).toBe(
        derivePeriodFromDateText('at closing'),
      );
    });

    it('should bound a refusal key over long text while keeping distinct texts distinct', () => {
      const first = derivePeriodFromDateText(`as reported ${'x'.repeat(400)} a`);
      const second = derivePeriodFromDateText(`as reported ${'x'.repeat(400)} b`);

      expect(first.length).toBeLessThan(128);
      expect(first).not.toBe(second);
    });
  });

  describe('the unstated period', () => {
    it.each(['', '   ', '\t\n', ' '])(
      'should treat %p as a period the source never stated, sharing one key',
      (text) => {
        expect(parsePeriod(text)).toEqual({ granularity: 'unstated', key: UNDATED_PERIOD });
      },
    );

    it('should keep an unstated period distinguishable from a refused one', () => {
      expect(derivePeriodFromDateText('')).not.toBe(derivePeriodFromDateText('at closing'));
    });
  });

  // Grouping compares keys, so a year-only prose fact and a month-dated spreadsheet row keep
  // separate keys and are never reported as disagreeing with each other. Coarsening the row to its
  // year instead would make a January figure and a December figure conflict; leaving the prose
  // fact where it is costs a conflict this product can only surface once a source states a month.
  // `periodsOverlap` is the looser comparison, and is what recovers the relationship at question
  // time (`resolveQuestionScopedConflictGroup`, `activities.ts`).
  it('should keep a year-only period and a month-dated period in separate groups while still overlapping', () => {
    const year = parsePeriod('2025');
    const month = parsePeriod('2025-03-14');

    expect(year.key).not.toBe(month.key);
    expect(periodsOverlap(year, month)).toBe(true);
  });
});

describe('periodsOverlap', () => {
  it.each([
    ['2025-03', '2025-03-14', true],
    ['2025', 'Q1 2025', true],
    ['Q1 2025', 'March 2025', true],
    ['Q1 2025', 'April 2025', false],
    ['2024', '2025', false],
    ['2025-01-31', '2025-02-01', false],
  ])('should report %p and %p as overlapping: %p', (left, right, expected) => {
    expect(periodsOverlap(parsePeriod(left), parsePeriod(right))).toBe(expected);
  });

  it.each(['FY2025', '', 'at closing'])(
    'should report %p as overlapping nothing, including a period of its own kind',
    (text) => {
      expect(periodsOverlap(parsePeriod(text), parsePeriod('2025'))).toBe(false);
      expect(periodsOverlap(parsePeriod(text), parsePeriod(text))).toBe(false);
    },
  );
});

describe('parsePeriodKey', () => {
  it.each([
    '2025-03-14',
    '2025-03',
    'March 2025',
    'Q1 2025',
    'FY2025',
    '2025',
    '',
    'at closing',
    `as reported ${'x'.repeat(400)}`,
  ])('should recover the same period %p was parsed into from its stored key alone', (text) => {
    const parsed = parsePeriod(text);

    expect(parsePeriodKey(parsed.key)).toEqual(parsed);
  });

  it.each(['H1-2025', '2025-Q5', '2025-13', 'whatever', '2025-03-14'])(
    'should fail closed on the unrecognized stored key %p by giving it no calendar range',
    (key) => {
      expect(parsePeriodKey(key).range).toBeUndefined();
      expect(parsePeriodKey(key).granularity).toBe('unparseable');
    },
  );
});

describe('findStatedPeriods', () => {
  it('should read a bare year out of a sentence, unlike a period field', () => {
    expect(findStatedPeriods('What was the cap rate in 2019?').map((period) => period.key)).toEqual(
      ['2019'],
    );
    expect(parsePeriod('the cap rate in 2019').granularity).toBe('unparseable');
  });

  it('should report one period when a sentence states the same period in more than one form', () => {
    expect(findStatedPeriods('the March 2025 figure, dated 2025-03-14')).toHaveLength(1);
  });

  it('should report each distinct period a sentence names, leaving the caller to refuse', () => {
    expect(
      findStatedPeriods('How did it move from 2019 to March 2025?').map((period) => period.key),
    ).toEqual(expect.arrayContaining(['2019', '2025-03']));
  });

  it('should not read a period out of a sentence that names none', () => {
    expect(findStatedPeriods('What is the cap rate for Northgate Business Park?')).toEqual([]);
  });

  // "may" is both a month name and an English modal verb. It resolves to a month only where a year
  // follows it, which is the shape that makes it a date reference rather than a verb.
  it('should read "may" as a month only where a year follows it', () => {
    expect(findStatedPeriods('the deal may close').map((period) => period.key)).toEqual([]);
    expect(findStatedPeriods('the deal closed in May 2025').map((period) => period.key)).toEqual([
      '2025-05',
    ]);
  });

  it('should not read a period out of a four-digit token that is not a plausible year', () => {
    expect(findStatedPeriods('the cap rate for suite 4820')).toEqual([]);
  });
});

describe('findStatedPeriodSpans', () => {
  // One phrase per `MATCHERS` form, in the order they appear in that array, plus the bare year
  // (`BARE_YEAR_MATCHER`, sentence-mode only). Each phrase is embedded in a sentence rather than
  // standing alone, so a span reading `text.slice(start, end)` back to `[0, text.length)` would not
  // pass by coincidence.
  it.each([
    ['closed on 2025-03-14 as planned', '2025-03-14'],
    ['closed on March 14, 2025 as planned', 'March 14, 2025'],
    ['closed on 14th of March 2025 as planned', '14th of March 2025'],
    ['reported for 2025-03 in full', '2025-03'],
    ['guided to Q1 2025 for the deal', 'Q1 2025'],
    ['guided to 2025-Q1 for the deal', '2025-Q1'],
    ['restated for FY2025 going forward', 'FY2025'],
    ['the March 2025 figure stands', 'March 2025'],
    ['discussed in 2019 at length', '2019'],
  ])('should yield a span matching the source text for %p', (text, matchedText) => {
    const spans = findStatedPeriodSpans(text);

    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(matchedText);
  });

  it('should carry every span findStatedPeriods dedupes by key, key-for-key', () => {
    const text = 'the March 2025 figure, dated 2025-03-14';
    const spans = findStatedPeriodSpans(text);

    // The same period stated twice in two forms yields two spans here — `findStatedPeriods`
    // dedupes exactly this list by `period.key` down to one.
    expect(spans.length).toBeGreaterThan(1);
    const dedupedByKey = [...new Map(spans.map((span) => [span.period.key, span.period])).values()];
    expect(dedupedByKey).toEqual(findStatedPeriods(text));
  });
});
