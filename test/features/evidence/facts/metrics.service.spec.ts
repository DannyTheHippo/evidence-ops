import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { MetricsService } from '../../../../src/features/evidence/facts/metrics.service';
import {
  orderForExtraction,
  toMeasureDefinitions,
  type MeasureDefinition,
} from '../../../../src/features/evidence/measures/measure-definition';
import { buildSeedMeasureRows } from '../../../../src/features/evidence/measures/measure-seed';
import { MeasuresService } from '../../../../src/features/evidence/measures/measures.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';

describe('MetricsService', () => {
  let service: MetricsService;

  const mockLogger = getMockLogger();
  const mockMeasuresService = {
    listConfirmedDefinitions: jest.fn(),
  } satisfies Record<keyof Pick<MeasuresService, 'listConfirmedDefinitions'>, jest.Mock>;

  const buildMeasureDefinitions = (tenantId = 'default'): MeasureDefinition[] =>
    orderForExtraction(
      toMeasureDefinitions(
        buildSeedMeasureRows(tenantId).map((row) => ({ ...row, _id: new Types.ObjectId() })),
      ),
    );

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricsService,
        { provide: MeasuresService, useValue: mockMeasuresService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<MetricsService>(MetricsService);
  });

  afterEach(() => jest.resetAllMocks());

  it('should project the tenant confirmed measures to id, label and canonicalUnit, in order', async () => {
    const definitions = buildMeasureDefinitions('t1');
    mockMeasuresService.listConfirmedDefinitions.mockResolvedValue(definitions);

    const result = await service.list('t1');

    expect(mockMeasuresService.listConfirmedDefinitions).toHaveBeenCalledWith('t1');
    expect(result).toEqual(
      definitions.map(({ id, label, canonicalUnit }) => ({ id, label, canonicalUnit })),
    );
  });

  it('should return an empty list when the tenant has no confirmed measures', async () => {
    mockMeasuresService.listConfirmedDefinitions.mockResolvedValue([]);

    const result = await service.list('t2');

    expect(result).toEqual([]);
  });
});
