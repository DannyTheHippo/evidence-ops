import type { mongo } from 'mongoose';
import { makeQdrantAwareSearch } from '../../../eval/qdrant/qdrant-aware-search';
import type { SearchByMode } from '../../../eval/retrieval/retrieval-comparison';
import type { ModeRetrievalHit, RetrievalMode } from '../../../eval/retrieval/retrieval-modes';
import { FakeEmbeddingProvider } from '../../../src/providers/embedding/fake-embedding.provider';

const HIT: ModeRetrievalHit = {
  chunkId: 'chunk-1',
  documentVersionId: 'docver-1',
  text: 'The cap rate is 6.5%.',
  locator: { kind: 'pdf-page', page: 3, extractorVersion: 'pdf-v1' },
};

describe('makeQdrantAwareSearch', () => {
  afterEach(() => jest.resetAllMocks());

  const db = {} as mongo.Db;
  const embeddingProvider = new FakeEmbeddingProvider();
  const query = { text: 'What is the cap rate?', tenantId: 'eval', limit: 10 };

  it.each<RetrievalMode>(['lexical', 'vector', 'hybrid'])(
    "should route '%s' to mongoSearch with the mode preserved",
    async (mode) => {
      const mongoSearch: jest.MockedFunction<SearchByMode> = jest.fn().mockResolvedValue([HIT]);
      const qdrantSearch = jest.fn().mockResolvedValue([HIT]);
      const search = makeQdrantAwareSearch(mongoSearch, qdrantSearch);

      const hits = await search(db, embeddingProvider, mode, query);

      expect(mongoSearch).toHaveBeenCalledWith(db, embeddingProvider, mode, query);
      expect(qdrantSearch).not.toHaveBeenCalled();
      expect(hits).toEqual([HIT]);
    },
  );

  it("should route 'qdrant-vector' to qdrantSearch without the db/mode arguments", async () => {
    const mongoSearch: jest.MockedFunction<SearchByMode> = jest.fn().mockResolvedValue([]);
    const qdrantSearch = jest.fn().mockResolvedValue([HIT]);
    const search = makeQdrantAwareSearch(mongoSearch, qdrantSearch);

    const hits = await search(db, embeddingProvider, 'qdrant-vector', query);

    expect(qdrantSearch).toHaveBeenCalledWith(embeddingProvider, query);
    expect(mongoSearch).not.toHaveBeenCalled();
    expect(hits).toEqual([HIT]);
  });
});
