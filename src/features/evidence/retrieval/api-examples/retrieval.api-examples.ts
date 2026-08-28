import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { RetrievedChunkResponseDto } from '../dtos/response/retrieved-chunk.response.dto';

const exampleChunk = {
  chunkId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  docVersionId: '65f1c2e4a1b2c3d4e5f6a7b9',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85',
  text: 'The cap rate for Northgate Business Park is approximately 6.10%.',
  locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
  documentId: '65f1c2e4a1b2c3d4e5f6a7b8',
  documentTitle: 'Northgate Business Park — Q3 Rent Roll',
  score: 0.0164,
};

export const retrievalApiExamples: Record<string, ApiResponseOptions> = {
  found: {
    status: HttpStatus.OK,
    description: 'Hybrid retrieval hits for the query, ranked as the store returns them.',
    type: RetrievedChunkResponseDto,
    examples: {
      example: {
        summary: 'One matching chunk',
        value: { docs: [exampleChunk], count: 1 },
      },
    },
  },
};
