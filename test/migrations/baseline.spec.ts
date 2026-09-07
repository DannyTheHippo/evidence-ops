import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from 'mongodb';
import { down, resolveVectorDimensions, up } from '../../migrations/0001-baseline';
import { METRIC_IDS } from '../../src/features/evidence/facts/metric-ontology';

const SCHEMAS_ROOT = join(__dirname, '..', '..', 'src', 'database', 'schemas');

const EVIDENCE_CHUNKS = 'evidence_chunks';
const TENANTS = 'tenants';

type IndexKeys = Record<string, unknown>;
type IndexOptions = Record<string, unknown>;

interface RecordedIndex {
  collection: string;
  keys: IndexKeys;
  options: IndexOptions;
}

interface SchemaIndexDeclaration {
  name: string;
  keys: IndexKeys;
  options: IndexOptions;
}

interface Recorder {
  db: Db;
  indexes: RecordedIndex[];
  droppedCollections: string[];
  seedCalls: { collection: string; args: unknown[] }[];
  searchIndexCalls: { collection: string; definitions: { name?: string; type?: string }[] }[];
}

/**
 * Records every call `up()`/`down()` make instead of asserting on a bare `jest.fn`, because the
 * baseline creates one index per schema-declared index and a positional `mock.calls[n]` lookup
 * would silently follow the table's ordering rather than the index under test.
 *
 * `listSearchIndexes` reports `READY` + `queryable` immediately: `waitForSearchIndexReady` polls
 * until both hold, so a mock that reports anything else parks the spec for the poll's whole budget.
 */
function createRecorder(): Recorder {
  const indexes: RecordedIndex[] = [];
  const droppedCollections: string[] = [];
  const seedCalls: Recorder['seedCalls'] = [];
  const searchIndexCalls: Recorder['searchIndexCalls'] = [];

  const collection = (name: string): unknown => ({
    createIndex: (keys: IndexKeys, options: IndexOptions): Promise<string> => {
      indexes.push({ collection: name, keys, options });
      return Promise.resolve(String(options.name));
    },
    updateOne: (...args: unknown[]): Promise<void> => {
      seedCalls.push({ collection: name, args });
      return Promise.resolve();
    },
    find: () => ({
      toArray: (): Promise<{ tenantId: string }[]> => Promise.resolve([{ tenantId: 'default' }]),
    }),
    createSearchIndexes: (definitions: { name?: string; type?: string }[]): Promise<string[]> => {
      searchIndexCalls.push({ collection: name, definitions });
      return Promise.resolve(definitions.map((definition) => String(definition.name)));
    },
    listSearchIndexes: (indexName: string) => ({
      toArray: (): Promise<unknown[]> =>
        Promise.resolve([{ name: indexName, status: 'READY', queryable: true }]),
    }),
    drop: (): Promise<boolean> => {
      droppedCollections.push(name);
      return Promise.resolve(true);
    },
  });

  return {
    db: { collection } as unknown as Db,
    indexes,
    droppedCollections,
    seedCalls,
    searchIndexCalls,
  };
}

function listSchemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listSchemaFiles(path);
    }
    return path.endsWith('.schema.ts') ? [path] : [];
  });
}

interface IndexedSchema {
  indexes(): [IndexKeys, IndexOptions][];
}

function isIndexedSchema(value: unknown): value is IndexedSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { indexes?: unknown }).indexes === 'function'
  );
}

/**
 * Every named index declared across the schema tree — the set `Model.syncIndexes()` builds for the
 * memory-server test lane (`test/utils/create-test-app.ts`). Deduplicated by name, since a schema
 * object re-exported under a second name would otherwise yield the same declaration twice.
 */
function collectSchemaIndexes(): SchemaIndexDeclaration[] {
  const byName = new Map<string, SchemaIndexDeclaration>();

  for (const file of listSchemaFiles(SCHEMAS_ROOT)) {
    // The schema set is discovered from disk at run time; a static import list would drift the
    // moment a schema is added, which is the drift this spec exists to catch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- run-time schema discovery
    const moduleExports = require(file) as Record<string, unknown>;
    for (const exported of Object.values(moduleExports)) {
      if (!isIndexedSchema(exported)) {
        continue;
      }
      for (const [keys, options] of exported.indexes()) {
        if (typeof options.name === 'string') {
          byName.set(options.name, { name: options.name, keys, options });
        }
      }
    }
  }

  return [...byName.values()];
}

const schemaIndexes = collectSchemaIndexes();

describe('migrations/0001-baseline', () => {
  it('extracts at least one named index from the schema tree', () => {
    // Guards the parity cases below against a silently empty `schemaIndexes` — a discovery walk
    // that stopped matching would otherwise make every `it.each` case pass vacuously, over zero
    // cases.
    expect(schemaIndexes.length).toBeGreaterThan(0);
  });

  /**
   * MongoDB refuses a second index on a key pattern it already carries under a different name, and
   * which declaration loses depends on boot order — so the schema and this migration must agree
   * exactly. Compared against each schema's own registered index rather than restated, so a change
   * to either side fails here instead of at whichever process starts first.
   */
  it.each(schemaIndexes.map((index) => [index.name, index] as const))(
    "creates '%s' with the keys and options its schema declares",
    async (name, declaration) => {
      const recorder = createRecorder();
      await up(recorder.db);

      const created = recorder.indexes.find((index) => index.options.name === name);
      expect(created).toBeDefined();
      expect(created?.keys).toEqual(declaration.keys);

      // `background` is Mongoose's own default on every schema-declared index and is not a
      // difference in what the index covers; nothing else may differ.
      const expectedOptions = { ...declaration.options };
      delete expectedOptions.background;
      expect(created?.options).toEqual(expectedOptions);
    },
  );

  it('should give every index it creates a distinct name', async () => {
    const recorder = createRecorder();
    await up(recorder.db);

    const names = recorder.indexes.map((index) => index.options.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should seed the default tenant registry row without overwriting an existing one', async () => {
    const recorder = createRecorder();
    await up(recorder.db);

    expect(recorder.seedCalls[0]).toEqual({
      collection: TENANTS,
      args: [
        { tenantId: 'default' },
        { $setOnInsert: { tenantId: 'default', name: 'Default tenant' } },
        { upsert: true },
      ],
    });
  });

  it('should upsert one seed measure per registry tenant, one per METRIC_IDS entry', async () => {
    const recorder = createRecorder();
    await up(recorder.db);

    const measureCalls = recorder.seedCalls.slice(1);
    expect(measureCalls).toHaveLength(METRIC_IDS.length);

    for (const call of measureCalls) {
      expect(call.collection).toBe('measures');

      const [filter, update, options] = call.args as [
        { tenantId: string; slug: string },
        { $setOnInsert: { tenantId: string; slug: string } },
        { upsert: boolean },
      ];
      expect(METRIC_IDS).toContain(filter.slug);
      expect(filter).toEqual({ tenantId: 'default', slug: filter.slug });
      expect(update.$setOnInsert).toMatchObject({ tenantId: 'default', slug: filter.slug });
      expect(options).toEqual({ upsert: true });
    }
  });

  it('should create the lexical and vector search indexes on evidence_chunks', async () => {
    const recorder = createRecorder();
    await up(recorder.db);

    expect(recorder.searchIndexCalls).toHaveLength(1);
    expect(recorder.searchIndexCalls[0].collection).toBe(EVIDENCE_CHUNKS);
    expect(
      recorder.searchIndexCalls[0].definitions.map((definition) => [
        definition.name,
        definition.type,
      ]),
    ).toEqual([
      ['evidence_chunks_search', 'search'],
      ['evidence_chunks_vector', 'vectorSearch'],
    ]);
  });

  it('should drop exactly the collections it creates on down', async () => {
    const upRecorder = createRecorder();
    await up(upRecorder.db);
    const created = [...new Set(upRecorder.indexes.map((index) => index.collection))].sort();

    const downRecorder = createRecorder();
    await down(downRecorder.db);

    expect([...downRecorder.droppedCollections].sort()).toEqual(created);
  });

  it('should drop verifications on down', async () => {
    const recorder = createRecorder();
    await down(recorder.db);

    expect(recorder.droppedCollections).toContain('verifications');
  });
});

describe('resolveVectorDimensions', () => {
  const originalEmbeddingDimensions = process.env.EMBEDDING_DIMENSIONS;

  afterEach(() => {
    if (originalEmbeddingDimensions === undefined) {
      delete process.env.EMBEDDING_DIMENSIONS;
    } else {
      process.env.EMBEDDING_DIMENSIONS = originalEmbeddingDimensions;
    }
  });

  it('defaults to 1024 when EMBEDDING_DIMENSIONS is unset', () => {
    delete process.env.EMBEDDING_DIMENSIONS;
    expect(resolveVectorDimensions()).toBe(1024);
  });

  it('defaults to 1024 when EMBEDDING_DIMENSIONS is blank', () => {
    process.env.EMBEDDING_DIMENSIONS = '   ';
    expect(resolveVectorDimensions()).toBe(1024);
  });

  it('reads a configured positive integer', () => {
    process.env.EMBEDDING_DIMENSIONS = '768';
    expect(resolveVectorDimensions()).toBe(768);
  });

  it('refuses 0', () => {
    process.env.EMBEDDING_DIMENSIONS = '0';
    expect(() => resolveVectorDimensions()).toThrow(
      'EMBEDDING_DIMENSIONS must be a positive integer, got "0"',
    );
  });

  it('refuses a non-numeric value', () => {
    process.env.EMBEDDING_DIMENSIONS = 'abc';
    expect(() => resolveVectorDimensions()).toThrow(
      'EMBEDDING_DIMENSIONS must be a positive integer, got "abc"',
    );
  });
});
