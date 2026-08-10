import { Injectable } from '@nestjs/common';
import type {
  EmbeddingProvider,
  EmbeddingProviderInfo,
  EmbeddingRequest,
  EmbeddingResult,
} from './embedding-provider.interface';

/**
 * Test double for `EmbeddingProvider`. Returns a deterministic vector per input (index-filled,
 * length = configured `dimensions`) so callers can assert shape without caring about values.
 */
@Injectable()
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;
  readonly calls: EmbeddingRequest[] = [];

  constructor(dimensions = 4) {
    this.info = { provider: 'fake', model: 'fake-embedding', dimensions };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    this.calls.push(request);

    return {
      embeddings: request.inputs.map(() => Array.from({ length: this.info.dimensions }, () => 0)),
      usage: { totalTokens: request.inputs.reduce((sum, input) => sum + input.length, 0) },
    };
  }
}
