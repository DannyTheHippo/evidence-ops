import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BaseException } from '../../src/shared/exceptions/base.exception';
import {
  EXTRACT_FACTS_NON_RETRYABLE_ERROR_TYPES,
  INGEST_HEARTBEAT_INTERVAL_MS,
  INGEST_HEARTBEAT_TIMEOUT_MS,
  INGEST_NON_RETRYABLE_ERROR_TYPES,
  INGEST_SCHEDULE_TO_CLOSE_TIMEOUT_MS,
  INGEST_START_TO_CLOSE_TIMEOUT_MS,
} from '../../src/workflows/ingest-retry-policy';

const INGESTION_ROOT = join(__dirname, '../../src/features/evidence/ingestion');

type Retryability = 'deterministic' | 'transient';

/**
 * How each exception the ingestion feature exports behaves under a retry, as a judgement about
 * that exception's cause — `'deterministic'` means a second attempt over the same bytes and the
 * same configuration reaches the same refusal, `'transient'` means it may not.
 *
 * The sweep below drives itself from the classes actually exported under `INGESTION_ROOT`, not
 * from this map: a new or renamed exception is discovered and fails as unclassified rather than
 * quietly defaulting to retryable. Deciding its retryability is a deliberate act, recorded here.
 */
const RETRYABILITY: Readonly<Record<string, Retryability>> = {
  IngestionAbandonedException: 'transient',
  DocumentVersionNotFoundException: 'deterministic',
  UnsupportedMimeTypeException: 'deterministic',
  MalformedCsvException: 'deterministic',
  MalformedDocxException: 'deterministic',
  MalformedPdfException: 'deterministic',
  EmptyPdfTextLayerException: 'deterministic',
  MalformedPptxException: 'deterministic',
  MalformedXlsxException: 'deterministic',
  HostileArchiveException: 'deterministic',
  MalformedEmailException: 'deterministic',
  HostileEmailException: 'deterministic',
};

/**
 * Names in `INGEST_NON_RETRYABLE_ERROR_TYPES` that are not ingestion-feature exception classes, so
 * the "no stale entry" assertion below can tell a deliberate non-local entry from the debris of a
 * rename. `MissingTenantId` is an `ApplicationFailure` type string minted in `activities.ts`; the
 * two Voyage names are embedding-provider errors.
 */
const NON_INGESTION_ENTRIES = new Set([
  'MissingTenantId',
  'VoyageApiKeyMissingError',
  'VoyageInvalidResponseError',
]);

type ExceptionConstructor = new (message: string, cause?: unknown) => BaseException;

interface DiscoveredException {
  readonly constructor: ExceptionConstructor;
  readonly files: readonly string[];
}

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listTsFiles(full);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

function isExceptionConstructor(value: unknown): value is ExceptionConstructor {
  if (typeof value !== 'function') {
    return false;
  }
  const prototype: unknown = (value as { prototype?: unknown }).prototype;
  return prototype instanceof BaseException;
}

/**
 * Every `BaseException` subclass reachable from the ingestion feature's own exports, keyed by the
 * class name Temporal matches on — a filesystem walk rather than a list of imports, so a parser
 * exception added in a new file is picked up without this test being edited.
 */
function discoverIngestionExceptions(): Map<string, DiscoveredException> {
  const discovered = new Map<string, DiscoveredException>();

  for (const file of listTsFiles(INGESTION_ROOT)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- paths come from the walk above, so they are known only at runtime; static imports would be the hand-maintained list this sweep replaces
    const moduleExports: unknown = require(file);
    if (typeof moduleExports !== 'object' || moduleExports === null) {
      continue;
    }

    for (const exported of Object.values(moduleExports)) {
      if (!isExceptionConstructor(exported)) {
        continue;
      }
      const existing = discovered.get(exported.name);
      discovered.set(exported.name, {
        constructor: exported,
        files: [...(existing?.files ?? []), file],
      });
    }
  }

  return discovered;
}

const ingestionExceptions = discoverIngestionExceptions();
const exceptionNames = [...ingestionExceptions.keys()].sort();

describe('ingestion exception retryability', () => {
  // A walk that silently found nothing would make every assertion below vacuously true.
  it('should discover the ingestion feature exception classes', () => {
    expect(exceptionNames.length).toBeGreaterThanOrEqual(9);
  });

  it('should report each discovered exception under its own class name', () => {
    const misnamed = exceptionNames.filter((name) => {
      const ExceptionClass = ingestionExceptions.get(name)?.constructor;
      return ExceptionClass === undefined || new ExceptionClass('probe').name !== name;
    });

    expect(misnamed).toEqual([]);
  });

  it('should carry exactly one class per exception name', () => {
    const duplicated = exceptionNames.filter(
      (name) => (ingestionExceptions.get(name)?.files.length ?? 0) > 1,
    );

    expect(duplicated).toEqual([]);
  });

  it('should classify every discovered exception as deterministic or transient', () => {
    const unclassified = exceptionNames.filter((name) => RETRYABILITY[name] === undefined);

    expect(unclassified).toEqual([]);
  });

  // Matched on a thrown instance's own `name`, not on the class name — that string is the only
  // thing Temporal compares against this list, so it is what has to be in it.
  it('should mark every deterministic exception non-retryable for ingestDocumentVersion', () => {
    const missing = exceptionNames.filter((name) => {
      if (RETRYABILITY[name] !== 'deterministic') {
        return false;
      }
      const ExceptionClass = ingestionExceptions.get(name)?.constructor;
      return (
        ExceptionClass === undefined ||
        !INGEST_NON_RETRYABLE_ERROR_TYPES.includes(new ExceptionClass('probe').name)
      );
    });

    expect(missing).toEqual([]);
  });

  it('should leave every transient exception retryable for ingestDocumentVersion', () => {
    const wronglyListed = exceptionNames.filter(
      (name) =>
        RETRYABILITY[name] === 'transient' && INGEST_NON_RETRYABLE_ERROR_TYPES.includes(name),
    );

    expect(wronglyListed).toEqual([]);
  });

  it('should carry no entry naming a class the ingestion feature no longer exports', () => {
    const stale = INGEST_NON_RETRYABLE_ERROR_TYPES.filter(
      (name) => !NON_INGESTION_ENTRIES.has(name) && !ingestionExceptions.has(name),
    );

    expect(stale).toEqual([]);
  });

  // `pdf.parser.ts` throws a bare `Error` for an internal invariant, and Nest's own
  // `InternalServerErrorException` leaves `name` at `'Error'` — listing that name would make every
  // unclassified failure, including a transient storage or Mongo blip, permanently non-retryable.
  it("should never list the bare 'Error' name in either group", () => {
    expect(INGEST_NON_RETRYABLE_ERROR_TYPES).not.toContain('Error');
    expect(EXTRACT_FACTS_NON_RETRYABLE_ERROR_TYPES).not.toContain('Error');
  });

  // Voyage's rate limit and request failures describe the moment, not the input: retrying is what
  // resolves them, so they must stay retryable however the deterministic list grows.
  it('should leave the embedding provider transient failures retryable', () => {
    expect(INGEST_NON_RETRYABLE_ERROR_TYPES).not.toContain('VoyageRateLimitExceededError');
    expect(INGEST_NON_RETRYABLE_ERROR_TYPES).not.toContain('VoyageRequestFailedError');
  });
});

describe('ingest activity timing policy', () => {
  // The relation, not the numbers: a heartbeat slower than its own timeout fails every healthy
  // attempt, and a timeout above `startToClose` never fires before the overall timeout does.
  it('should heartbeat faster than the heartbeat timeout, which fires before startToClose', () => {
    expect(INGEST_HEARTBEAT_INTERVAL_MS).toBeLessThan(INGEST_HEARTBEAT_TIMEOUT_MS);
    expect(INGEST_HEARTBEAT_TIMEOUT_MS).toBeLessThan(INGEST_START_TO_CLOSE_TIMEOUT_MS);
    expect(INGEST_START_TO_CLOSE_TIMEOUT_MS).toBeLessThan(INGEST_SCHEDULE_TO_CLOSE_TIMEOUT_MS);
  });
});
