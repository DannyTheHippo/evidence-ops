import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMAS_ROOT = join(__dirname, '..', '..', 'src', 'database', 'schemas');
const MIGRATIONS_ROOT = join(__dirname, '..', '..', 'migrations');

/**
 * Matches only an explicit Mongoose index-options `name: '...'`, never a `@Prop({ ... }) name:
 * string` field declaration (no quotes follow the colon there) or a key-direction entry like
 * `{ name: 1 }` inside an index's key spec (a bare number, not a quoted string).
 */
const INDEX_NAME_PATTERN = /name:\s*'([^']+)'/g;

function listFilesRecursively(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFilesRecursively(path) : [path];
  });
}

function extractIndexNames(fileContent: string): string[] {
  return [...fileContent.matchAll(INDEX_NAME_PATTERN)].map((match) => match[1]);
}

/**
 * Proves that every named index a schema declares — the set `Model.syncIndexes()` builds for the
 * memory-server test lane (`test/utils/create-test-app.ts`) — has a same-named counterpart
 * somewhere in `migrations/*.ts`, the mechanism that builds it in a deployed database where
 * `autoIndex` is off (`src/config/mongo.config.ts`). Migration index names live in file-local
 * `const`s rather than inline literals, so this checks the *text* of every migration file, not a
 * structured export — proving only that the name string is present somewhere in migration
 * source, never that the migration's key pattern or options (`unique`, TTL, partial filter, etc.)
 * match the schema's own declaration.
 */
describe('schema/migration index-name parity', () => {
  const schemaFiles = listFilesRecursively(SCHEMAS_ROOT).filter((file) =>
    file.endsWith('.schema.ts'),
  );
  const migrationsText = listFilesRecursively(MIGRATIONS_ROOT)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(file, 'utf-8'))
    .join('\n');

  const schemaIndexNames = schemaFiles.flatMap((file) =>
    extractIndexNames(readFileSync(file, 'utf-8')),
  );

  it('extracts at least one named index from the schema tree', () => {
    // Guards the parity checks below against a silently empty `schemaIndexNames` — an extraction
    // regex that stopped matching (e.g. after a schema file rename) would otherwise make every
    // `it.each` case below pass vacuously, over zero cases.
    expect(schemaIndexNames.length).toBeGreaterThan(0);
  });

  it.each(schemaIndexNames)("migrations/*.ts contains the schema index name '%s'", (indexName) => {
    expect(migrationsText).toContain(indexName);
  });
});
