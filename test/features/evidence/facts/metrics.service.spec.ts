import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import { MetricsService } from '../../../../src/features/evidence/facts/metrics.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';

describe('MetricsService', () => {
  let service: MetricsService;

  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MetricsService, { provide: AppLogger, useValue: mockLogger }],
    }).compile();

    service = module.get<MetricsService>(MetricsService);
  });

  afterEach(() => jest.resetAllMocks());

  it('should project every METRIC_ONTOLOGY entry to its id, label and canonicalUnit', () => {
    const result = service.list();

    expect(result).toEqual(
      METRIC_ONTOLOGY.map((metric) => ({
        id: metric.id,
        label: metric.label,
        canonicalUnit: metric.canonicalUnit,
      })),
    );
  });
});
