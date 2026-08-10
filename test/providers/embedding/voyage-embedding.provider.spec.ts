import { VoyageApiKeyMissingError } from '../../../src/providers/embedding/errors/voyage-api-key-missing.error';
import { VoyageRequestFailedError } from '../../../src/providers/embedding/errors/voyage-request-failed.error';
import { VoyageEmbeddingProvider } from '../../../src/providers/embedding/voyage-embedding.provider';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

interface VoyageRequestBody {
  readonly input: string[];
  readonly input_type: string;
}

function buildResponse(inputs: readonly string[]): Response {
  const body = {
    data: inputs.map((_, index) => ({ embedding: [index], index })),
    usage: { total_tokens: inputs.length * 2 },
  };

  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function buildFailedResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not called')),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('VoyageEmbeddingProvider', () => {
  const originalFetch = globalThis.fetch;
  // `jest.spyOn(globalThis, 'fetch')` fails here — `fetch` is not an own property of the
  // Jest-node `globalThis`, only an inherited one, so `spyOn` can't patch it. Assigning
  // directly and restoring the original reference afterwards works regardless.
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should throw VoyageApiKeyMissingError before any request when no key is configured', async () => {
    const provider = new VoyageEmbeddingProvider(getMockTypedConfig());

    await expect(
      provider.embed({ inputs: ['hello'], inputType: 'document' }),
    ).rejects.toBeInstanceOf(VoyageApiKeyMissingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return an empty result without calling fetch for an empty input list', async () => {
    const provider = new VoyageEmbeddingProvider(
      getMockTypedConfig({ voyage: { apiKey: 'voyage-key', model: 'voyage-4', dimensions: 1024 } }),
    );

    const result = await provider.embed({ inputs: [], inputType: 'document' });

    expect(result).toEqual({ embeddings: [], usage: { totalTokens: 0 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should set input_type to "document" for document embeds and "query" for query embeds', async () => {
    const provider = new VoyageEmbeddingProvider(
      getMockTypedConfig({ voyage: { apiKey: 'voyage-key', model: 'voyage-4', dimensions: 1024 } }),
    );
    fetchMock.mockResolvedValue(buildResponse(['a']));

    await provider.embed({ inputs: ['a'], inputType: 'document' });
    await provider.embed({ inputs: ['a'], inputType: 'query' });

    const calls = fetchMock.mock.calls as [string, { body: string }][];
    const [documentCall, queryCall] = calls;
    const documentBody = JSON.parse(documentCall[1].body) as VoyageRequestBody;
    const queryBody = JSON.parse(queryCall[1].body) as VoyageRequestBody;
    expect(documentBody.input_type).toBe('document');
    expect(queryBody.input_type).toBe('query');
  });

  it('should batch at the 1000-input vendor limit', async () => {
    const provider = new VoyageEmbeddingProvider(
      getMockTypedConfig({ voyage: { apiKey: 'voyage-key', model: 'voyage-4', dimensions: 1024 } }),
    );
    const inputs = Array.from({ length: 1001 }, (_, i) => `input-${i}`);
    fetchMock.mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as VoyageRequestBody;
      return Promise.resolve(buildResponse(body.input));
    });

    const result = await provider.embed({ inputs, inputType: 'document' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as [string, { body: string }][];
    const [firstCall, secondCall] = calls;
    const firstBody = JSON.parse(firstCall[1].body) as VoyageRequestBody;
    const secondBody = JSON.parse(secondCall[1].body) as VoyageRequestBody;
    expect(firstBody.input).toHaveLength(1000);
    expect(secondBody.input).toHaveLength(1);
    expect(result.embeddings).toHaveLength(1001);
  });

  it('should surface a non-2xx response as VoyageRequestFailedError', async () => {
    const provider = new VoyageEmbeddingProvider(
      getMockTypedConfig({ voyage: { apiKey: 'voyage-key', model: 'voyage-4', dimensions: 1024 } }),
    );
    fetchMock.mockResolvedValue(buildFailedResponse(500, 'internal error'));

    const error = await provider
      .embed({ inputs: ['a'], inputType: 'document' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoyageRequestFailedError);
    expect((error as VoyageRequestFailedError).status).toBe(500);
    expect((error as VoyageRequestFailedError).body).toBe('internal error');
  });

  it('should report token usage summed across every batch', async () => {
    const provider = new VoyageEmbeddingProvider(
      getMockTypedConfig({ voyage: { apiKey: 'voyage-key', model: 'voyage-4', dimensions: 1024 } }),
    );
    const inputs = Array.from({ length: 1001 }, (_, i) => `input-${i}`);
    fetchMock.mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as VoyageRequestBody;
      return Promise.resolve(buildResponse(body.input));
    });

    const result = await provider.embed({ inputs, inputType: 'document' });

    expect(result.usage.totalTokens).toBe(1000 * 2 + 1 * 2);
  });
});
