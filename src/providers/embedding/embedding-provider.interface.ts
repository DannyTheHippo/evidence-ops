export type EmbeddingInputType = 'document' | 'query';

export interface EmbeddingRequest {
  readonly inputs: readonly string[];
  readonly inputType: EmbeddingInputType;
}

export interface EmbeddingUsage {
  readonly totalTokens: number;
}

export interface EmbeddingResult {
  readonly embeddings: readonly (readonly number[])[];
  readonly usage: EmbeddingUsage;
}

export interface EmbeddingProviderInfo {
  readonly provider: string;
  readonly model: string;
  /** Read by index creation instead of hardcoding the vector dimension count. */
  readonly dimensions: number;
}

export interface EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
