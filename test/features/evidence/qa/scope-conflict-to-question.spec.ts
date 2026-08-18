import type { ConflictedFactGroup } from '../../../../src/features/evidence/conflicts/conflicts.service';
import type { CanonicalEntityListing } from '../../../../src/features/evidence/facts/canonical-entity.service';
import {
  filterGroupsByEntity,
  resolveQuestionEntity,
  scopeConflictToQuestion,
} from '../../../../src/features/evidence/qa/scope-conflict-to-question';

function buildEntity(overrides: Partial<CanonicalEntityListing> = {}): CanonicalEntityListing {
  return {
    canonicalName: 'Northgate Business Park',
    canonicalNameNormalized: 'northgate business park',
    aliasesNormalized: [],
    ...overrides,
  };
}

function buildGroup(overrides: Partial<ConflictedFactGroup> = {}): ConflictedFactGroup {
  return {
    conflictId: 'conflict-1',
    factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
    values: [
      { value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
      { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-prose' },
    ],
    ...overrides,
  };
}

describe('resolveQuestionEntity', () => {
  it('should resolve the entity when its canonical name occurs in the question', () => {
    const entity = buildEntity();

    expect(
      resolveQuestionEntity('What is the cap rate for Northgate Business Park?', [entity]),
    ).toEqual(entity);
  });

  it('should resolve the entity when one of its aliases occurs in the question', () => {
    const entity = buildEntity({ aliasesNormalized: ['northgate bus. park'] });

    expect(
      resolveQuestionEntity('What is the cap rate for Northgate Bus. Park?', [entity]),
    ).toEqual(entity);
  });

  it('should match case-insensitively and across collapsed whitespace, mirroring normalizeEntityName', () => {
    const entity = buildEntity();

    expect(
      resolveQuestionEntity('what is the cap rate for   NORTHGATE   business PARK ?', [entity]),
    ).toEqual(entity);
  });

  it('should return null when a bare substring occurs but no whole-token match does', () => {
    // "gate" occurs inside "northgate" as a substring but never as its own token.
    const entity = buildEntity({ canonicalName: 'Gate', canonicalNameNormalized: 'gate' });

    expect(
      resolveQuestionEntity('What is the cap rate for Northgate Business Park?', [entity]),
    ).toBeNull();
  });

  it('should return null when the question contains only part of a multi-word canonical name', () => {
    const entity = buildEntity();

    expect(
      resolveQuestionEntity('What is the cap rate for Business Park East?', [entity]),
    ).toBeNull();
  });

  it('should return null when the question names zero registered entities', () => {
    expect(resolveQuestionEntity('What is the going-in cap rate?', [buildEntity()])).toBeNull();
  });

  it('should return null when the question names more than one distinct entity', () => {
    const northgate = buildEntity();
    const sablewood = buildEntity({
      canonicalName: 'Sablewood Retail Court',
      canonicalNameNormalized: 'sablewood retail court',
    });

    expect(
      resolveQuestionEntity(
        'Compare the cap rate for Northgate Business Park against Sablewood Retail Court.',
        [northgate, sablewood],
      ),
    ).toBeNull();
  });

  it('should return null for an empty question', () => {
    expect(resolveQuestionEntity('', [buildEntity()])).toBeNull();
  });

  it('should return null against an empty registry', () => {
    expect(
      resolveQuestionEntity('What is the cap rate for Northgate Business Park?', []),
    ).toBeNull();
  });

  it('should never match an empty alias, but still match the canonical name on the same entity', () => {
    const entity = buildEntity({ aliasesNormalized: [''] });

    expect(
      resolveQuestionEntity('What is the cap rate for Northgate Business Park?', [entity]),
    ).toEqual(entity);
  });

  it('should never match a name that normalizes to only whitespace tokens', () => {
    // Defensive: `normalizeEntityName` itself never produces this shape, but a caller building
    // `CanonicalEntityListing` by hand could — the whole-token match must still refuse, not throw.
    const entity = buildEntity({ canonicalNameNormalized: ' ' });

    expect(
      resolveQuestionEntity('What is the cap rate for Northgate Business Park?', [entity]),
    ).toBeNull();
  });
});

describe('filterGroupsByEntity', () => {
  it("should keep only groups whose factKey.entity normalizes to the entity's canonical name", () => {
    const northgateGroup = buildGroup();
    const sablewoodGroup = buildGroup({
      conflictId: 'conflict-2',
      factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' },
    });

    expect(filterGroupsByEntity([northgateGroup, sablewoodGroup], buildEntity())).toEqual([
      northgateGroup,
    ]);
  });

  it("should keep a group whose factKey.entity normalizes to one of the entity's aliases", () => {
    const group = buildGroup({
      factKey: { ...buildGroup().factKey, entity: 'Northgate Bus. Park' },
    });
    const entity = buildEntity({ aliasesNormalized: ['northgate bus. park'] });

    expect(filterGroupsByEntity([group], entity)).toEqual([group]);
  });

  it('should return an empty array when no group belongs to the entity', () => {
    const sablewoodGroup = buildGroup({
      factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' },
    });

    expect(filterGroupsByEntity([sablewoodGroup], buildEntity())).toEqual([]);
  });
});

describe('scopeConflictToQuestion', () => {
  it('should return the single group belonging to the entity the question names', () => {
    const group = buildGroup();

    expect(
      scopeConflictToQuestion(
        'What is the cap rate for Northgate Business Park?',
        [group],
        [buildEntity()],
      ),
    ).toEqual(group);
  });

  // The point of the module: a second property's conflict group, legitimately retrieved
  // alongside the first (e.g. from the same spreadsheet), must never attach to a question about
  // a different property.
  it("should attach only the group for the named property, never the other property's group retrieved alongside it", () => {
    const northgateGroup = buildGroup();
    const sablewoodGroup = buildGroup({
      conflictId: 'conflict-2',
      factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' },
      values: [{ value: 4.9, unit: 'percent', sourceChunkId: 'chunk-sablewood' }],
    });
    const entities = [
      buildEntity(),
      buildEntity({
        canonicalName: 'Sablewood Retail Court',
        canonicalNameNormalized: 'sablewood retail court',
      }),
    ];

    const result = scopeConflictToQuestion(
      'What is the cap rate for Sablewood Retail Court?',
      [northgateGroup, sablewoodGroup],
      entities,
    );

    expect(result).toEqual(sablewoodGroup);
  });

  it('should return null when the question names zero entities', () => {
    expect(
      scopeConflictToQuestion('What is the going-in cap rate?', [buildGroup()], [buildEntity()]),
    ).toBeNull();
  });

  it('should return null when the question names more than one entity, rather than guessing between their groups', () => {
    const northgateGroup = buildGroup();
    const sablewoodGroup = buildGroup({
      conflictId: 'conflict-2',
      factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' },
    });
    const entities = [
      buildEntity(),
      buildEntity({
        canonicalName: 'Sablewood Retail Court',
        canonicalNameNormalized: 'sablewood retail court',
      }),
    ];

    expect(
      scopeConflictToQuestion(
        'Compare the cap rate for Northgate Business Park against Sablewood Retail Court.',
        [northgateGroup, sablewoodGroup],
        entities,
      ),
    ).toBeNull();
  });

  it('should return null when the resolved entity matches zero retrieved conflict groups', () => {
    expect(
      scopeConflictToQuestion(
        'What is the cap rate for Northgate Business Park?',
        [
          buildGroup({
            factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' },
          }),
        ],
        [buildEntity()],
      ),
    ).toBeNull();
  });

  it('should return null when the resolved entity matches more than one retrieved conflict group', () => {
    // Same entity, two different metrics — the question names the property but not which
    // disagreement about it, so attaching either would still be a guess.
    const capRateGroup = buildGroup();
    const occupancyGroup = buildGroup({
      conflictId: 'conflict-2',
      factKey: { entity: 'Northgate Business Park', metric: 'occupancy_rate', period: '2025-03' },
    });

    expect(
      scopeConflictToQuestion(
        'What is going on with Northgate Business Park?',
        [capRateGroup, occupancyGroup],
        [buildEntity()],
      ),
    ).toBeNull();
  });
});
