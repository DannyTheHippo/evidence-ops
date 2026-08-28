import { normalizeEntityName } from '../../../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import {
  detectConflicts,
  groupKey,
  type FactForConflictScan,
} from '../../../../src/features/evidence/conflicts/detect-conflicts';

function fact(overrides: Partial<FactForConflictScan> = {}): FactForConflictScan {
  return {
    id: 'fact-id',
    factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
    value: { amount: 5.25, unit: 'percent' },
    ...overrides,
  };
}

describe('detectConflicts', () => {
  it('should emit no conflict for a single fact (nothing to disagree with)', () => {
    expect(detectConflicts([fact({ id: 'a' })], METRIC_ONTOLOGY)).toEqual({
      conflicts: [],
      skipped: [],
    });
  });

  it('should emit a conflict when two facts sharing a key disagree past tolerance', () => {
    const facts = [
      fact({ id: 'xlsx-fact', value: { amount: 5.25, unit: 'percent' } }),
      fact({ id: 'pdf-fact', value: { amount: 6.1, unit: 'percent' } }),
    ];

    const { conflicts, skipped } = detectConflicts(facts, METRIC_ONTOLOGY);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].factKey).toEqual(facts[0].factKey);
    expect(conflicts[0].factIds.sort()).toEqual(['pdf-fact', 'xlsx-fact']);
    expect(conflicts[0].magnitude).toBeCloseTo(0.0085, 10);
    // cap_rate's canonical unit, not a fixed constant — a currency metric's group would carry
    // 'usd' instead (see the sale_price case below).
    expect(conflicts[0].magnitudeUnit).toBe('ratio');
    expect(skipped).toEqual([]);
  });

  it('should stamp magnitudeUnit with a currency metric’s canonical unit', () => {
    const facts = [
      fact({
        id: 'a',
        factKey: { entity: 'Sablewood Retail Court', metric: 'sale_price', period: '2025-03' },
        value: { amount: 41_000_000, unit: 'usd' },
      }),
      fact({
        id: 'b',
        factKey: { entity: 'Sablewood Retail Court', metric: 'sale_price', period: '2025-03' },
        value: { amount: 42_500_000, unit: 'usd' },
      }),
    ];

    const { conflicts } = detectConflicts(facts, METRIC_ONTOLOGY);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].magnitudeUnit).toBe('usd');
  });

  it('should not emit a conflict when two facts sharing a key agree within tolerance', () => {
    const facts = [
      fact({ id: 'a', value: { amount: 5.25, unit: 'percent' } }),
      fact({ id: 'b', value: { amount: 5.26, unit: 'percent' } }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY)).toEqual({ conflicts: [], skipped: [] });
  });

  it('should group entities case-insensitively and trimmed, but keep metric and period exact', () => {
    const facts = [
      fact({
        id: 'a',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      }),
      fact({
        id: 'b',
        factKey: { entity: '  northgate business park  ', metric: 'cap_rate', period: '2025-03' },
        value: { amount: 6.1, unit: 'percent' },
      }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY).conflicts).toHaveLength(1);
  });

  it('should not group facts with the same entity+metric but a different period', () => {
    const facts = [
      fact({
        id: 'a',
        factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-02' },
      }),
      fact({
        id: 'b',
        factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: 'undated' },
        value: { amount: 6.1, unit: 'percent' },
      }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY).conflicts).toEqual([]);
  });

  it('should not group facts for different entities or different metrics', () => {
    const facts = [
      fact({
        id: 'a',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      }),
      fact({
        id: 'b',
        factKey: { entity: 'Cedar Bluff Logistics Center', metric: 'cap_rate', period: '2025-03' },
        value: { amount: 9.9, unit: 'percent' },
      }),
      fact({
        id: 'c',
        factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-03' },
        value: { amount: 999, unit: 'usd' },
      }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY).conflicts).toEqual([]);
  });

  it('should include every fact in the group in factIds, not just the extremal pair', () => {
    const facts = [
      fact({ id: 'a', value: { amount: 5.25, unit: 'percent' } }),
      fact({ id: 'b', value: { amount: 5.26, unit: 'percent' } }),
      fact({ id: 'c', value: { amount: 6.1, unit: 'percent' } }),
    ];

    const { conflicts } = detectConflicts(facts, METRIC_ONTOLOGY);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].factIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('should skip a group whose metric id is not in the ontology, without throwing', () => {
    const facts = [
      fact({ id: 'a', factKey: { entity: 'X', metric: 'not_a_real_metric', period: 'undated' } }),
      fact({
        id: 'b',
        factKey: { entity: 'X', metric: 'not_a_real_metric', period: 'undated' },
        value: { amount: 999, unit: 'percent' },
      }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY)).toEqual({ conflicts: [], skipped: [] });
  });

  it('should return no conflicts for an empty fact list', () => {
    expect(detectConflicts([], METRIC_ONTOLOGY)).toEqual({ conflicts: [], skipped: [] });
  });

  // Regression for the live `npm run eval -- --record` failure: a model-extracted `price_per_sf`
  // fact carried unit 'usd', which the ontology does not define for that metric
  // (metric-ontology.ts's `price_per_sf` only lists `usd_per_sf`). The live traceback shows the
  // throw happening inside the `Array.map` that normalized one *group's* facts together
  // (detect-conflicts.ts:69, inside the map at :67) — reproduced here by putting the
  // un-normalizable fact in the *same* group as a genuine conflict, not an unrelated singleton.
  // Against the pre-fix code, `normalizeFactValue` threw `UnknownMetricUnitError` from inside that
  // group's `.map()`, aborting the scan before the xlsx/pdf conflict below it was ever emitted.
  it('should skip an un-normalizable fact and still detect a conflict among the rest of its own group', () => {
    const facts = [
      fact({
        id: 'xlsx-fact',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        value: { amount: 5.25, unit: 'percent' },
      }),
      fact({
        id: 'pdf-fact',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        value: { amount: 6.1, unit: 'percent' },
      }),
      fact({
        id: 'model-fact',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        value: { amount: 250, unit: 'usd' },
      }),
    ];

    const { conflicts, skipped } = detectConflicts(facts, METRIC_ONTOLOGY);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].factIds.sort()).toEqual(['pdf-fact', 'xlsx-fact']);
    expect(skipped).toEqual([
      {
        fact: facts[2],
        reason: "Metric 'cap_rate' does not define a conversion for unit 'usd'",
      },
    ]);
  });

  it('should skip a whole group when dropping its un-normalizable fact leaves fewer than two comparable values', () => {
    const facts = [
      fact({
        id: 'a',
        factKey: { entity: 'Sablewood Retail Court', metric: 'price_per_sf', period: '2025-03' },
        value: { amount: 250, unit: 'usd_per_sf' },
      }),
      fact({
        id: 'b',
        factKey: { entity: 'Sablewood Retail Court', metric: 'price_per_sf', period: '2025-03' },
        value: { amount: 250, unit: 'usd' },
      }),
    ];

    const { conflicts, skipped } = detectConflicts(facts, METRIC_ONTOLOGY);

    expect(conflicts).toEqual([]);
    expect(skipped).toEqual([
      {
        fact: facts[1],
        reason: "Metric 'price_per_sf' does not define a conversion for unit 'usd'",
      },
    ]);
  });

  // Defence in depth behind the extractor's numeric grammar: a stored fact predating that grammar
  // can still carry a non-finite amount, and this function must not compare it. `Infinity` and
  // `NaN` both make every `>` in `isConflictingPair` false, so an unguarded comparison reads as
  // agreement and closes the group's real disagreement silently. Parameterized over both, and over
  // an absolute-tolerance metric (cap_rate) and a relative-tolerance one (sale_price), because the
  // two tolerance kinds fail in opposite directions on the same input.
  describe.each([
    { label: 'Infinity', amount: Infinity },
    { label: '-Infinity', amount: -Infinity },
    { label: 'NaN', amount: NaN },
  ])('a fact carrying $label', ({ amount }) => {
    it.each([
      {
        metric: 'cap_rate',
        unit: 'percent',
        lower: 5.25,
        higher: 6.1,
        canonicalUnit: 'ratio',
      },
      {
        metric: 'sale_price',
        unit: 'usd',
        lower: 100_000,
        higher: 120_000,
        canonicalUnit: 'usd',
      },
    ])(
      'should skip it and still detect the real disagreement in its $metric group',
      ({ metric, unit, lower, higher, canonicalUnit }) => {
        const factKey = { entity: 'Northgate Business Park', metric, period: '2025-03' };
        const facts = [
          fact({ id: 'poisoned', factKey, value: { amount, unit } }),
          fact({ id: 'low', factKey, value: { amount: lower, unit } }),
          fact({ id: 'high', factKey, value: { amount: higher, unit } }),
        ];

        const { conflicts, skipped } = detectConflicts(facts, METRIC_ONTOLOGY);

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].factIds.sort()).toEqual(['high', 'low']);
        expect(Number.isFinite(conflicts[0].magnitude)).toBe(true);
        expect(skipped).toHaveLength(1);
        expect(skipped[0].fact.id).toBe('poisoned');
        expect(skipped[0].reason).toContain(`finite ${canonicalUnit} value`);
      },
    );

    it('should skip it rather than emit a conflict of infinite magnitude when it is the only pair', () => {
      const factKey = {
        entity: 'Northgate Business Park',
        metric: 'sale_price',
        period: '2025-03',
      };
      const facts = [
        fact({ id: 'poisoned', factKey, value: { amount, unit: 'usd' } }),
        fact({ id: 'real', factKey, value: { amount: 41_000_000, unit: 'usd' } }),
      ];

      const { conflicts, skipped } = detectConflicts(facts, METRIC_ONTOLOGY);

      expect(conflicts).toEqual([]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].fact.id).toBe('poisoned');
    });
  });

  // The same guard covers a finite amount whose *conversion* overflows — a magnitude unit multiplies
  // the stored amount, so the non-finite value can appear only after normalization.
  it('should skip a fact whose finite amount converts to a non-finite canonical value', () => {
    const factKey = { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-03' };
    const facts = [
      fact({ id: 'overflowing', factKey, value: { amount: 1e308, unit: 'usd_millions' } }),
      fact({ id: 'low', factKey, value: { amount: 41_000_000, unit: 'usd' } }),
      fact({ id: 'high', factKey, value: { amount: 45_000_000, unit: 'usd' } }),
    ];

    const { conflicts, skipped } = detectConflicts(facts, METRIC_ONTOLOGY);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].factIds.sort()).toEqual(['high', 'low']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].fact.id).toBe('overflowing');
  });
});

describe('groupKey', () => {
  const keyFor = (entity: string) => groupKey({ entity, metric: 'sale_price', period: '2025' });

  it('should key entity case-insensitively and trimmed', () => {
    expect(keyFor('Acme')).toBe(keyFor('  ACME  '));
  });

  it('should key through the same normalization the CanonicalEntity registry stores names under', () => {
    expect(keyFor('Acme  Tower')).toBe(`${normalizeEntityName('Acme  Tower')}::sale_price::2025`);
  });

  // The normalization class, swept rather than sampled. A single spacing or compatibility
  // character that survives normalization splits one entity's facts into two groups, and two
  // groups of one fact each never disagree — the conflict disappears with nothing to report it.
  describe('names that differ only by a fold this normalization performs', () => {
    it('should collapse every Unicode space-separator code point, including the ones NFKC leaves alone', () => {
      const spaceSeparators: string[] = [];
      for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
        const char = String.fromCodePoint(codePoint);
        if (/\p{Zs}/u.test(char)) {
          spaceSeparators.push(char);
        }
      }
      // Pinned, not sampled: a Unicode revision that adds a space separator must fail here so the
      // new code point is checked against this normalization rather than reaching it unexamined.
      expect(spaceSeparators).toHaveLength(17);

      for (const separator of spaceSeparators) {
        const rendered = `Acme${separator}${separator}Tower`;
        expect([separator.codePointAt(0), keyFor(rendered)]).toEqual([
          separator.codePointAt(0),
          keyFor('Acme Tower'),
        ]);
      }
    });

    const withChar = (template: string, codePoint: number) =>
      template.replace('_', String.fromCodePoint(codePoint));

    it.each([
      [
        'fullwidth letters a PDF text layer emits',
        '\uFF21\uFF43\uFF4D\uFF45 \uFF34\uFF4F\uFF57\uFF45\uFF52',
        'acme tower',
      ],
      ['a compatibility ligature', 'O\uFB03ce Tower', 'office tower'],
      ['a no-break space', withChar('Acme_Tower', 0x00a0), 'acme tower'],
      ['an ideographic space', withChar('Acme_Tower', 0x3000), 'acme tower'],
      ['a narrow no-break space', withChar('Acme_Tower', 0x202f), 'acme tower'],
      [
        'an Ogham space mark, which NFKC leaves alone',
        withChar('Acme_Tower', 0x1680),
        'acme tower',
      ],
      ['a superscript digit', withChar('Acme Tower_', 0x00b2), 'acme tower2'],
      ['a Roman numeral', withChar('Acme Tower _', 0x2171), 'acme tower ii'],
      ['mixed casing and a whitespace run', '  ACME \t Tower  ', 'acme tower'],
    ])('should key %s as %p', (_description, rendered, expected) => {
      expect(keyFor(rendered)).toBe(`${expected}::sale_price::2025`);
    });
  });

  // The other half of the class: folding too much fabricates an agreement between two properties
  // that were never the same, which is the failure `CanonicalEntity` refuses fuzzy matching over.
  it.each([
    ['Acme Tower', 'Acme Towers'],
    ['Acme Tower', 'AcmeTower'],
    ['Acme Tower', 'Acme-Tower'],
    ['Acme Tower', 'Acme Tower II'],
    ['Northgate Business Park', 'Northgate Bus. Park'],
  ])('should keep %p and %p in separate groups', (left, right) => {
    expect(keyFor(left)).not.toBe(keyFor(right));
  });

  it('should keep the metric and period apart from the entity, so no entity name can forge either', () => {
    expect(keyFor('Acme::sale_price::2024')).not.toBe(
      groupKey({ entity: 'Acme', metric: 'sale_price', period: '2024' }),
    );
  });

  // A combining acute accent is two code points until NFKC's canonical composition step folds it
  // into the one precomposed letter a spreadsheet or PDF text layer would emit for the same name.
  it('should key a combining accent composed by NFKC the same as the precomposed letter', () => {
    expect(keyFor('Café Tower')).toBe(`café tower::sale_price::2025`);
  });

  // Generated rather than hand-listed: every base entity is rendered through every variation class
  // below, crossed with a spread of real metric ids and period keys, so the properties below hold
  // over the whole (entity × metric × period) domain rather than the handful of pairs sampled
  // above. 5 entities × 8 variations × 5 metrics × 3 periods = 600 rows.
  describe('over a generated (entity × metric × period) domain', () => {
    const BASE_ENTITIES = [
      'Acme Tower',
      'Northgate Business Park',
      'Cedar Bluff Logistics Center',
      'Sablewood Retail Court',
      'Café Meridian',
    ];
    const METRICS = [
      'cap_rate',
      'sale_price',
      'price_per_sf',
      'net_operating_income',
      'base_rent_psf',
    ];
    const PERIODS = ['2025-03', '2025-02', 'undated'];

    // ASCII printable range 0x21–0x7E maps one-to-one onto the fullwidth block at +0xFEE0, the
    // same compatibility equivalence a PDF text layer's fullwidth rendering carries.
    const toFullwidth = (value: string) =>
      value.replace(/[!-~]/g, (char) => String.fromCodePoint(char.codePointAt(0)! + 0xfee0));

    const VARIATIONS: Array<{ label: string; transform: (base: string) => string }> = [
      { label: 'identity', transform: (base) => base },
      { label: 'uppercase', transform: (base) => base.toUpperCase() },
      { label: 'lowercase', transform: (base) => base.toLowerCase() },
      { label: 'fullwidth letters', transform: toFullwidth },
      { label: 'no-break spaces', transform: (base) => base.replace(/ /g, ' ') },
      { label: 'ideographic spaces', transform: (base) => base.replace(/ /g, '　') },
      { label: 'padded whitespace runs', transform: (base) => `  ${base.replace(/ /g, '   ')}  ` },
      // NFD splits every precomposed accented letter a base entity carries (Café Meridian's é)
      // back into base letter + combining mark, round-tripping through the form NFKC's
      // composition step folds together.
      { label: 'decomposed combining marks', transform: (base) => base.normalize('NFD') },
    ];

    interface DomainRow {
      readonly baseEntity: string;
      readonly entity: string;
      readonly metric: string;
      readonly period: string;
    }

    const DOMAIN: DomainRow[] = BASE_ENTITIES.flatMap((baseEntity) =>
      VARIATIONS.flatMap(({ transform }) =>
        METRICS.flatMap((metric) =>
          PERIODS.map((period) => ({
            baseEntity,
            entity: transform(baseEntity),
            metric,
            period,
          })),
        ),
      ),
    );

    it('should have generated a domain at least as wide as the migration-era sweep it replaces', () => {
      expect(DOMAIN.length).toBeGreaterThanOrEqual(570);
    });

    it('should fold idempotently: normalizing an already-normalized name changes nothing', () => {
      for (const row of DOMAIN) {
        const once = normalizeEntityName(row.entity);
        expect(normalizeEntityName(once)).toBe(once);
      }
    });

    it('should agree with normalizeEntityName on the entity component for every input', () => {
      for (const row of DOMAIN) {
        const key = groupKey({ entity: row.entity, metric: row.metric, period: row.period });
        const [entityComponent] = key.split('::');
        expect(entityComponent).toBe(normalizeEntityName(row.entity));
      }
    });

    it('should key deterministically: the same input yields the same key across repeated calls', () => {
      for (const row of DOMAIN) {
        const factKey = { entity: row.entity, metric: row.metric, period: row.period };
        expect(groupKey(factKey)).toBe(groupKey(factKey));
        expect(normalizeEntityName(row.entity)).toBe(normalizeEntityName(row.entity));
      }
    });

    it('should collapse every variation of one entity into one key, and keep distinct entities apart, holding metric and period fixed', () => {
      const keysByBucket = new Map<string, Set<string>>();
      for (const row of DOMAIN) {
        const bucket = `${row.baseEntity}::${row.metric}::${row.period}`;
        const key = groupKey({ entity: row.entity, metric: row.metric, period: row.period });
        const seen = keysByBucket.get(bucket) ?? new Set<string>();
        seen.add(key);
        keysByBucket.set(bucket, seen);
      }

      // Every variant of one base entity, held to the same metric and period, resolves to exactly
      // one key — a fold that leaves a second key here would split one entity's facts in two.
      for (const [bucket, keys] of keysByBucket) {
        expect([bucket, keys.size]).toEqual([bucket, 1]);
      }

      // Distinct base entities, held to the same metric and period, never collapse into each
      // other's key — a fold that collided here would let two properties silently agree.
      for (const metric of METRICS) {
        for (const period of PERIODS) {
          const keysForBaseEntities = BASE_ENTITIES.map(
            (baseEntity) => [...keysByBucket.get(`${baseEntity}::${metric}::${period}`)!][0],
          );
          expect(new Set(keysForBaseEntities).size).toBe(BASE_ENTITIES.length);
        }
      }
    });
  });
});
