import { Types } from 'mongoose';
import {
  orderForExtraction,
  toMeasureDefinitions,
  validateMeasureDefinition,
  type MeasureDefinition,
} from '../../../../src/features/evidence/measures/measure-definition';
import { buildSeedMeasureRows } from '../../../../src/features/evidence/measures/measure-seed';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import { InvalidMeasureDefinitionException } from '../../../../src/features/evidence/measures/exceptions/measures.exception';

describe('orderForExtraction', () => {
  const seedDefinitions = toMeasureDefinitions(
    buildSeedMeasureRows('t').map((row) => ({ ...row, _id: new Types.ObjectId() })),
  );

  it('reproduces METRIC_ONTOLOGY byte-for-byte, in order, for a seed-only tenant', () => {
    const ordered = orderForExtraction(seedDefinitions);
    const projected = ordered.map(
      ({
        measureId: _measureId,
        version: _version,
        status: _status,
        origin: _origin,
        ...metricFields
      }) => metricFields,
    );

    expect(projected).toEqual(METRIC_ONTOLOGY);
  });

  it('sorts a header-origin row after every seed row, regardless of its slug', () => {
    const headerRow: MeasureDefinition = {
      id: 'aaa_header_metric',
      label: 'AAA Header Metric',
      aliases: ['AAA Header Metric'],
      valueType: 'count',
      canonicalUnit: 'count',
      units: [{ id: 'count', toCanonicalFactor: 1 }],
      toleranceKind: 'absolute',
      tolerance: 0,
      measureId: new Types.ObjectId().toString(),
      version: 1,
      status: 'proposed',
      origin: 'header',
    };

    const ordered = orderForExtraction([headerRow, ...seedDefinitions]);

    expect(ordered.at(-1)).toEqual(headerRow);
    expect(ordered.slice(0, seedDefinitions.length).map((def) => def.id)).toEqual(
      seedDefinitions.map((def) => def.id),
    );
  });

  it('sorts multiple non-seed rows by id ascending', () => {
    const rowB: MeasureDefinition = {
      id: 'zzz_metric',
      label: 'ZZZ',
      aliases: ['ZZZ'],
      valueType: 'count',
      canonicalUnit: 'count',
      units: [{ id: 'count', toCanonicalFactor: 1 }],
      toleranceKind: 'absolute',
      tolerance: 0,
      measureId: new Types.ObjectId().toString(),
      version: 1,
      status: 'confirmed',
      origin: 'manual',
    };
    const rowA: MeasureDefinition = { ...rowB, id: 'aaa_metric', label: 'AAA' };

    expect(orderForExtraction([rowB, rowA]).map((def) => def.id)).toEqual([
      'aaa_metric',
      'zzz_metric',
    ]);
  });
});

describe('validateMeasureDefinition', () => {
  const validDefinition = {
    label: 'Cap Rate',
    aliases: ['Cap Rate', 'capitalization rate'],
    canonicalUnit: 'ratio',
    units: [
      { id: 'ratio', toCanonicalFactor: 1 },
      { id: 'percent', toCanonicalFactor: 0.01 },
    ],
    tolerance: 0.0025,
    authorityOrder: ['pm-export', 'spreadsheet'] as const,
    stalenessWindowMs: 180 * 24 * 60 * 60 * 1000,
  };

  it('does not throw for a valid definition', () => {
    expect(() => validateMeasureDefinition(validDefinition)).not.toThrow();
  });

  // `METRIC_ONTOLOGY` itself is not run through this validator (`buildSeedMeasureRows` writes it
  // straight to `insertMany`), and two of its entries (`cap_rate`'s `'Cap Rate'`/`'cap rate'`,
  // `price_per_sf`'s `'$/sf'`/`'$/SF'`) carry the exact case-variant redundancy this validator
  // rejects on a human-submitted edit — so this suite exercises the rule against a fabricated
  // definition instead of asserting every ontology entry passes it.
  it('accepts every METRIC_ONTOLOGY unit table and tolerance, independent of alias casing', () => {
    for (const metric of METRIC_ONTOLOGY) {
      expect(() =>
        validateMeasureDefinition({
          label: metric.label,
          aliases: [metric.label],
          canonicalUnit: metric.canonicalUnit,
          units: metric.units.map((unit) => ({ ...unit })),
          tolerance: metric.tolerance,
          authorityOrder: metric.authorityOrder ? [...metric.authorityOrder] : undefined,
          stalenessWindowMs: metric.stalenessWindowMs,
        }),
      ).not.toThrow();
    }
  });

  it.each([
    ['no units', { ...validDefinition, units: [] }, 'at least one unit'],
    [
      'duplicate unit ids',
      {
        ...validDefinition,
        units: [
          { id: 'ratio', toCanonicalFactor: 1 },
          { id: 'ratio', toCanonicalFactor: 0.01 },
        ],
      },
      'unique ids',
    ],
    [
      'a unit id outside the slug grammar',
      {
        ...validDefinition,
        units: [
          { id: 'Ratio', toCanonicalFactor: 1 },
          { id: 'percent', toCanonicalFactor: 0.01 },
        ],
      },
      'must match',
    ],
    [
      'a non-finite unit factor',
      {
        ...validDefinition,
        units: [
          { id: 'ratio', toCanonicalFactor: 1 },
          { id: 'percent', toCanonicalFactor: Number.POSITIVE_INFINITY },
        ],
      },
      'toCanonicalFactor',
    ],
    [
      'a non-positive unit factor',
      {
        ...validDefinition,
        units: [
          { id: 'ratio', toCanonicalFactor: 1 },
          { id: 'percent', toCanonicalFactor: 0 },
        ],
      },
      'toCanonicalFactor',
    ],
    [
      'no unit at factor 1',
      { ...validDefinition, units: [{ id: 'percent', toCanonicalFactor: 0.01 }] },
      'exactly one unit',
    ],
    [
      'a canonicalUnit that does not match the factor-1 unit',
      {
        ...validDefinition,
        canonicalUnit: 'percent',
        units: [
          { id: 'ratio', toCanonicalFactor: 1 },
          { id: 'percent', toCanonicalFactor: 0.01 },
        ],
      },
      'exactly one unit',
    ],
    ['a non-finite tolerance', { ...validDefinition, tolerance: Number.NaN }, 'tolerance'],
    ['a negative tolerance', { ...validDefinition, tolerance: -0.01 }, 'tolerance'],
    ['an empty label', { ...validDefinition, label: '' }, 'label'],
    ['a label over 200 characters', { ...validDefinition, label: 'a'.repeat(201) }, 'label'],
    ['an empty alias', { ...validDefinition, aliases: [''] }, 'alias'],
    ['an alias over 200 characters', { ...validDefinition, aliases: ['a'.repeat(201)] }, 'alias'],
    [
      'case-insensitive duplicate aliases',
      { ...validDefinition, aliases: ['Cap Rate', 'cap rate '] },
      'duplicates another alias',
    ],
    [
      'an unclassified authorityOrder entry',
      { ...validDefinition, authorityOrder: ['unclassified'] as const },
      'classified document source',
    ],
    [
      'a duplicate authorityOrder entry',
      { ...validDefinition, authorityOrder: ['pm-export', 'pm-export'] as const },
      'duplicates source class',
    ],
    [
      'a non-integer stalenessWindowMs',
      { ...validDefinition, stalenessWindowMs: 1.5 },
      'stalenessWindowMs',
    ],
    [
      'a negative stalenessWindowMs',
      { ...validDefinition, stalenessWindowMs: -1 },
      'stalenessWindowMs',
    ],
  ])('throws InvalidMeasureDefinitionException for %s', (_name, definition, messageFragment) => {
    expect(() => validateMeasureDefinition(definition)).toThrow(InvalidMeasureDefinitionException);
    expect(() => validateMeasureDefinition(definition)).toThrow(messageFragment);
  });
});
