import { Injectable } from '@nestjs/common';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { VoyageApiKeyMissingError } from './errors/voyage-api-key-missing.error';
import { VoyageRequestFailedError } from './errors/voyage-request-failed.error';
import type {
  EmbeddingInputType,
  EmbeddingProvider,
  EmbeddingProviderInfo,
  EmbeddingRequest,
  EmbeddingResult,
} from './embedding-provider.interface';

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
/** Vendor limit: at most 1000 inputs per request. */
const MAX_INPUTS_PER_REQUEST = 1000;

interface VoyageEmbeddingsResponse {
  readonly data: { readonly embedding: number[]; readonly index: number }[];
  readonly usage: { readonly total_tokens: number };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Thin typed fetch client, not the vendor SDK — Voyage's embeddings API is a single endpoint,
 * and retry/telemetry behaviour belongs in decorators at this layer, not in a vendor library.
 */
@Injectable()
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  constructor(private readonly config: TypedConfigService) {
    this.info = {
      provider: 'voyage',
      model: this.config.voyage.model,
      dimensions: this.config.voyage.dimensions,
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.inputs.length === 0) {
      return { embeddings: [], usage: { totalTokens: 0 } };
    }

    const batches = chunk(request.inputs, MAX_INPUTS_PER_REQUEST);
    const results = await Promise.all(
      batches.map((batch) => this.embedBatch(batch, request.inputType)),
    );

    return {
      embeddings: results.flatMap((result) => result.embeddings),
      usage: { totalTokens: results.reduce((sum, result) => sum + result.usage.totalTokens, 0) },
    };
  }

  private async embedBatch(
    inputs: readonly string[],
    inputType: EmbeddingInputType,
  ): Promise<EmbeddingResult> {
    const apiKey = this.config.voyage.apiKey;
    if (!apiKey) {
      throw new VoyageApiKeyMissingError();
    }

    const response = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: inputs,
        model: this.info.model,
        input_type: inputType,
        output_dimension: this.info.dimensions,
        truncation: true,
      }),
    });

    if (!response.ok) {
      throw new VoyageRequestFailedError(response.status, await response.text());
    }

    const body = (await response.json()) as VoyageEmbeddingsResponse;
    const embeddings = [...body.data]
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.embedding);

    return { embeddings, usage: { totalTokens: body.usage.total_tokens } };
  }
}
