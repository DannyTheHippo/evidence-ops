import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { CanonicalEntityListing } from '../../../../src/features/evidence/facts/canonical-entity.service';
import { CanonicalEntityService } from '../../../../src/features/evidence/facts/canonical-entity.service';
import type { MeasureDefinition } from '../../../../src/features/evidence/measures/measure-definition';
import { MeasuresService } from '../../../../src/features/evidence/measures/measures.service';
import {
  QuestionResolverService,
  resolveQuestion,
  type ResolverMeasure,
} from '../../../../src/features/evidence/qa/question-resolver.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger, type MockLogger } from '../../../utils/get-mock-logger';

function buildEntity(overrides: Partial<CanonicalEntityListing> = {}): CanonicalEntityListing {
  return {
    canonicalName: 'Northgate Business Park',
    canonicalNameNormalized: 'northgate business park',
    aliasesNormalized: [],
    ...overrides,
  };
}

const CAP_RATE: ResolverMeasure = { slug: 'cap_rate', label: 'Cap Rate', aliases: ['cap rate'] };

describe('resolveQuestion', () => {
  it('should resolve entity, measure and an absent period when the question names none', () => {
    expect(
      resolveQuestion(
        'What is the cap rate for Northgate Business Park?',
        [buildEntity()],
        [CAP_RATE],
      ),
    ).toEqual({ kind: 'resolved', entity: 'Northgate Business Park', measure: 'cap_rate' });
  });

  it('should resolve via an entity alias', () => {
    const entity = buildEntity({ aliasesNormalized: ['northgate bus. park'] });

    expect(
      resolveQuestion('What is the cap rate for Northgate Bus. Park?', [entity], [CAP_RATE]),
    ).toEqual({ kind: 'resolved', entity: 'Northgate Business Park', measure: 'cap_rate' });
  });

  it('should resolve via a measure alias when the label itself does not occur', () => {
    const measure: ResolverMeasure = {
      slug: 'cap_rate',
      label: 'Capitalization Rate',
      aliases: ['going-in yield'],
    };

    expect(
      resolveQuestion(
        'What is the going-in yield for Northgate Business Park?',
        [buildEntity()],
        [measure],
      ),
    ).toEqual({ kind: 'resolved', entity: 'Northgate Business Park', measure: 'cap_rate' });
  });

  it('should return unresolved no-entity when the question names zero registered entities', () => {
    expect(resolveQuestion('What is the cap rate?', [buildEntity()], [CAP_RATE])).toEqual({
      kind: 'unresolved',
      reason: 'no-entity',
    });
  });

  it('should return unresolved no-entity for a whole-token negative — a longer word never matches on a bare substring', () => {
    const entity = buildEntity({
      canonicalName: 'Northgate',
      canonicalNameNormalized: 'northgate',
    });

    expect(resolveQuestion('What is the cap rate for Northgateway?', [entity], [CAP_RATE])).toEqual(
      { kind: 'unresolved', reason: 'no-entity' },
    );
  });

  it('should return unresolved ambiguous-entity when the question names two distinct entities', () => {
    const sablewood = buildEntity({
      canonicalName: 'Sablewood Retail Court',
      canonicalNameNormalized: 'sablewood retail court',
    });

    expect(
      resolveQuestion(
        'Compare the cap rate for Northgate Business Park against Sablewood Retail Court.',
        [buildEntity(), sablewood],
        [CAP_RATE],
      ),
    ).toEqual({ kind: 'unresolved', reason: 'ambiguous-entity' });
  });

  it('should return unresolved no-measure when zero measures match', () => {
    expect(
      resolveQuestion('What is the cap rate for Northgate Business Park?', [buildEntity()], []),
    ).toEqual({ kind: 'unresolved', reason: 'no-measure' });
  });

  it('should return unresolved ambiguous-measure when two distinct measures match', () => {
    const goingInCapRate: ResolverMeasure = {
      slug: 'going_in_cap_rate',
      label: 'Going-In Cap Rate',
      aliases: ['cap rate'],
    };

    expect(
      resolveQuestion(
        'What is the cap rate for Northgate Business Park?',
        [buildEntity()],
        [CAP_RATE, goingInCapRate],
      ),
    ).toEqual({ kind: 'unresolved', reason: 'ambiguous-measure' });
  });

  it.each([
    ['Q1 2024', '2024-Q1'],
    ['FY2024', 'FY2024'],
    ['March 2024', '2024-03'],
  ])('should resolve the stated period %s to %s', (stated, key) => {
    expect(
      resolveQuestion(
        `What was the cap rate for Northgate Business Park in ${stated}?`,
        [buildEntity()],
        [CAP_RATE],
      ),
    ).toEqual({
      kind: 'resolved',
      entity: 'Northgate Business Park',
      measure: 'cap_rate',
      period: key,
    });
  });

  it('should return unresolved ambiguous-period when the question states two distinct periods', () => {
    expect(
      resolveQuestion(
        'Compare the cap rate for Northgate Business Park in 2023 and 2024.',
        [buildEntity()],
        [CAP_RATE],
      ),
    ).toEqual({ kind: 'unresolved', reason: 'ambiguous-period' });
  });

  it('should return unresolved numeric-constraint for a bare non-period number no stated period explains', () => {
    expect(
      resolveQuestion(
        'Is the cap rate for Northgate Business Park above 6%?',
        [buildEntity()],
        [CAP_RATE],
      ),
    ).toEqual({ kind: 'unresolved', reason: 'numeric-constraint' });
  });

  it('should return unresolved numeric-constraint for an unparseable quarter whose own number a bare-year fallback cannot explain', () => {
    // "Q5" is not a real quarter, so the quarter matcher never accepts it and only the bare year
    // "2024" is read as a stated period — leaving "5" unexplained.
    expect(
      resolveQuestion(
        'What was the cap rate for Northgate Business Park in Q5 2024?',
        [buildEntity()],
        [CAP_RATE],
      ),
    ).toEqual({ kind: 'unresolved', reason: 'numeric-constraint' });
  });
});

describe('QuestionResolverService', () => {
  interface Harness {
    readonly service: QuestionResolverService;
    readonly canonicalEntityService: { listCanonicalEntities: jest.Mock };
    readonly measuresService: { listConfirmedDefinitions: jest.Mock };
    readonly logger: MockLogger;
  }

  async function buildHarness(): Promise<Harness> {
    const canonicalEntityService = { listCanonicalEntities: jest.fn().mockResolvedValue([]) };
    const measuresService = { listConfirmedDefinitions: jest.fn().mockResolvedValue([]) };
    const logger = getMockLogger();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuestionResolverService,
        { provide: CanonicalEntityService, useValue: canonicalEntityService },
        { provide: MeasuresService, useValue: measuresService },
        { provide: AppLogger, useValue: logger },
      ],
    }).compile();

    return {
      service: module.get(QuestionResolverService),
      canonicalEntityService,
      measuresService,
      logger,
    };
  }

  const CAP_RATE_DEFINITION: MeasureDefinition = {
    id: 'cap_rate',
    label: 'Cap Rate',
    aliases: ['cap rate'],
    valueType: 'percentage',
    canonicalUnit: 'ratio',
    units: [
      { id: 'ratio', toCanonicalFactor: 1 },
      { id: 'percent', toCanonicalFactor: 0.01 },
    ],
    toleranceKind: 'absolute',
    tolerance: 0.0025,
    measureId: 'measure-cap-rate',
    version: 1,
    status: 'confirmed',
    origin: 'seed',
  };

  it('should load the tenant registry via listConfirmedDefinitions — never a broader status listing — and resolve', async () => {
    const harness = await buildHarness();
    harness.canonicalEntityService.listCanonicalEntities.mockResolvedValueOnce([buildEntity()]);
    harness.measuresService.listConfirmedDefinitions.mockResolvedValueOnce([CAP_RATE_DEFINITION]);

    const result = await harness.service.resolve(
      'What is the cap rate for Northgate Business Park?',
      'tenant-1',
    );

    expect(result).toEqual({
      kind: 'resolved',
      entity: 'Northgate Business Park',
      measure: 'cap_rate',
    });
    expect(harness.canonicalEntityService.listCanonicalEntities).toHaveBeenCalledWith('tenant-1');
    expect(harness.measuresService.listConfirmedDefinitions).toHaveBeenCalledWith('tenant-1');
    expect(harness.logger.debug).not.toHaveBeenCalled();
  });

  it('should not resolve against a measure listConfirmedDefinitions did not return — a proposed-only measure never matches', async () => {
    const harness = await buildHarness();
    harness.canonicalEntityService.listCanonicalEntities.mockResolvedValueOnce([buildEntity()]);
    // `listConfirmedDefinitions` already excludes proposed rows; the service trusts that filter
    // rather than re-filtering `status` itself.
    harness.measuresService.listConfirmedDefinitions.mockResolvedValueOnce([]);

    const result = await harness.service.resolve(
      'What is the cap rate for Northgate Business Park?',
      'tenant-1',
    );

    expect(result).toEqual({ kind: 'unresolved', reason: 'no-measure' });
    expect(harness.logger.debug).toHaveBeenCalledWith(expect.stringContaining('no-measure'));
  });
});
