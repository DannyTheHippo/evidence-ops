import type { INestApplicationContext } from '@nestjs/common';
import { IngestionService } from '../../src/features/evidence/ingestion/ingestion.service';
import { createActivities } from '../../src/worker/activities';

describe('createActivities', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should resolve IngestionService from the given application context', () => {
    const mockGet = jest.fn().mockReturnValue({ ingestVersion: jest.fn() });
    const app = { get: mockGet } as unknown as INestApplicationContext;

    createActivities(app);

    expect(mockGet).toHaveBeenCalledWith(IngestionService);
  });

  it('should delegate ingestDocumentVersion to IngestionService.ingestVersion', async () => {
    const mockIngestVersion = jest
      .fn()
      .mockResolvedValue({ chunksCreated: 3, alreadyIngested: false });
    const app = {
      get: jest.fn().mockReturnValue({ ingestVersion: mockIngestVersion }),
    } as unknown as INestApplicationContext;

    const activities = createActivities(app);
    const result = await activities.ingestDocumentVersion('doc-1');

    expect(mockIngestVersion).toHaveBeenCalledWith('doc-1');
    expect(result).toEqual({ chunksCreated: 3, alreadyIngested: false });
  });
});
