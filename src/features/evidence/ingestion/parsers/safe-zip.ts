import { HttpStatus } from '@nestjs/common';
import type JSZip from 'jszip';
import { BaseException } from '../../../../shared/exceptions/base.exception';

/**
 * Shared zip hardening for the OOXML parsers. DOCX and XLSX are both zip+XML containers and carry
 * exactly the same archive-level risks, so the guard lives here once: two copies of security code
 * drift, and the copy that does not get the fix is the one an attacker finds.
 */

/**
 * Bounds the per-entry work a caller does once the archive is open — `readEntryTextBounded` and
 * `assertArchiveInflatesWithinBudget` each set up one stream per entry they touch. It does not
 * bound the cost of the entries existing: `JSZip.loadAsync` builds one object per
 * central-directory record before any check here runs, so that cost is already paid by the time
 * this counts them, and what holds it down is the upload endpoint's limit on compressed bytes.
 *
 * **Stated limit: this number cannot tell a hostile archive from an unusually large honest one.**
 * A package declares its part count truthfully whatever its author intended, so unlike the size
 * checks below there is no contradiction here to detect — only a judgement about which counts a
 * real producer emits. The two meanings cannot be given separate thresholds either, because the
 * lower one always fires first, so whichever number stands here carries both. It keeps the hostile
 * class on the reading that the shapes reaching it are packaging attacks, and that reading is what
 * a slide deck with per-slide notes and images can falsify: such a deck runs to a few thousand
 * parts, which is the same order as this limit rather than far below it.
 */
const MAX_ZIP_ENTRIES = 2000;

// Sized against media payloads rather than XML parts: a data-room document's bulk is images, and
// these sit far above what one of those weighs.
const MAX_ENTRY_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

/**
 * The ceiling `readEntryTextBounded` enforces against real, observed decompressed bytes — not the
 * archive's own declared sizes. Every part read through it is OOXML text (a `document.xml`, a
 * slide, a relationship file), never the multi-hundred-MB media payloads the declared caps above
 * exist to bound, so this sits far below them on purpose.
 */
const MAX_INFLATED_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Input gate: fails CLOSED. Any entry-count, size or path violation rejects the whole archive
 * rather than handing a partially-checked buffer to a parser.
 */
export class HostileArchiveException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/**
 * `_data` is populated from the ZIP central directory as soon as `JSZip.loadAsync` resolves, so
 * the sizes can be inspected before anything is inflated. It is not part of JSZip's public types,
 * hence this narrow local shape rather than an `any` cast.
 */
interface DeclaredZipEntrySize {
  readonly _data?: {
    readonly compressedSize?: number;
    readonly uncompressedSize?: number;
  };
}

/** The entry's own claim about what it inflates to, as recorded in the ZIP central directory. */
export function declaredUncompressedBytes(entry: JSZip.JSZipObject): number {
  return (entry as unknown as DeclaredZipEntrySize)._data?.uncompressedSize ?? 0;
}

function assertSafeEntryPath(entry: JSZip.JSZipObject): void {
  // `unsafeOriginalName` is the raw in-archive path before JSZip normalises it; `name` is the
  // folded form. Checking the raw name is the point — normalisation is what hides a traversal.
  const rawName = entry.unsafeOriginalName ?? entry.name;
  if (rawName.startsWith('/') || rawName.split('/').includes('..')) {
    throw new HostileArchiveException(
      `Archive entry "${rawName}" uses an absolute or traversal path`,
    );
  }
}

/**
 * Runs entirely off the central directory's declared sizes and entry names, before any entry is
 * inflated.
 *
 * **Known limit, deliberately accepted:** the declared sizes come from the archive itself, so a
 * crafted zip can under-report them and slip past these caps, and the real cost is only paid when
 * an entry is decompressed. That is why this is not the only control — the upload endpoint caps
 * the compressed payload before a parser ever sees it, and every part a caller goes on to read is
 * bounded by real inflated bytes through `readEntryTextBounded` or
 * `assertArchiveInflatesWithinBudget`. Treat this as a cheap first filter, not a
 * decompression-bomb proof.
 *
 * There is no declared-compression-ratio check here, because a ratio is not evidence of anything
 * an archive has to answer for: repetitive text genuinely compresses several hundred to one, so
 * the ratio refuses ordinary content, while an archive that under-declares its sizes shows a ratio
 * below 1:1 and passes. Both bombs and bulk are caught by the real-byte guards instead.
 */
export function assertSafeArchive(zip: JSZip): void {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new HostileArchiveException(
      `Archive has ${entries.length} entries, exceeding the ${MAX_ZIP_ENTRIES} limit`,
    );
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    assertSafeEntryPath(entry);
    if (entry.dir) {
      continue;
    }

    const uncompressedSize = declaredUncompressedBytes(entry);

    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new HostileArchiveException(
        `Archive entry "${entry.name}" declares ${uncompressedSize} uncompressed bytes, exceeding the ${MAX_ENTRY_UNCOMPRESSED_BYTES} limit`,
      );
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new HostileArchiveException(
        `Archive declares more than ${MAX_TOTAL_UNCOMPRESSED_BYTES} total uncompressed bytes`,
      );
    }
  }
}

/**
 * A running total of real decompressed bytes, shared across every part read from one archive via
 * `readEntryTextBounded`. Threading the same instance through every call for one `parse()` means a
 * caller reading N parts spends the cap once across all of them, not N times over.
 */
export interface InflateBudget {
  remainingBytes: number;
}

/** Creates a fresh {@link InflateBudget}, defaulting to this module's inflated-text ceiling. */
export function createInflateBudget(maxBytes: number = MAX_INFLATED_TEXT_BYTES): InflateBudget {
  return { remainingBytes: maxBytes };
}

/**
 * `internalStream` is JSZip's chunked read API — it is not part of the public `JSZipObject` type,
 * because the type declarations only expose the whole-result `async()`/`nodeStream()` methods. It
 * is what lets a caller observe real inflated bytes as the decompressor produces them, rather than
 * only after the entire result has already been accumulated in memory.
 */
interface StreamingZipEntry {
  readonly internalStream: {
    (type: 'text'): JSZip.JSZipStreamHelper<string>;
    (type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
  };
}

/**
 * Bounds every entry an archive contains by the bytes the inflater actually produces, for callers
 * that hand the whole buffer to a loader which materializes parts on its own. Fails CLOSED on two
 * properties an archive cannot lie its way past:
 *
 * - no entry may inflate beyond the size its own central directory declares, and
 * - the archive as a whole may not inflate beyond `budget`.
 *
 * Either refusal pauses the stream on the chunk that crosses the line, so the rest of the entry is
 * never inflated. Every entry is in scope, whatever it is named: a loader that decides what a part
 * is only after inflating it has already paid for the parts it goes on to ignore, so a name-based
 * subset bounds the archive nowhere except where the subset happens to reach.
 *
 * Inflating each entry here and again in the loader is the accepted cost of the check.
 */
export async function assertArchiveInflatesWithinBudget(
  zip: JSZip,
  budget: InflateBudget,
): Promise<void> {
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) {
      continue;
    }
    // Sequential on purpose: the budget bounds how much this pass ever holds inflated at once,
    // which inflating entries concurrently would defeat.
    await assertEntryInflatesWithinBudget(entry, budget);
  }
}

function assertEntryInflatesWithinBudget(
  entry: JSZip.JSZipObject,
  budget: InflateBudget,
): Promise<void> {
  const declaredBytes = declaredUncompressedBytes(entry);

  return new Promise((resolve, reject) => {
    let inflatedBytes = 0;
    let settled = false;

    const stream = (entry as unknown as StreamingZipEntry).internalStream('uint8array');
    const refuse = (message: string): void => {
      settled = true;
      stream.pause();
      reject(new HostileArchiveException(message));
    };

    stream
      .on('data', (chunk) => {
        if (settled) {
          return;
        }
        inflatedBytes += chunk.length;
        budget.remainingBytes -= chunk.length;
        if (inflatedBytes > declaredBytes) {
          refuse(
            `Archive entry "${entry.name}" declares ${declaredBytes} uncompressed bytes but inflates past that`,
          );
          return;
        }
        if (budget.remainingBytes < 0) {
          refuse(`Archive entry "${entry.name}" inflated past the shared archive budget`);
        }
      })
      .on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      })
      .on('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      })
      .resume();
  });
}

/**
 * Reads `entry` as text through JSZip's chunked internal stream, decrementing `budget` by each
 * chunk's real byte length as the inflater produces it. Fails CLOSED against actual decompression,
 * not the declared sizes `assertSafeArchive` checks: a hostile archive's central directory can
 * under-report an entry's true size (`assertSafeArchive`'s own limit, accepted above), so the only
 * trustworthy signal is the byte count coming out of the inflater itself. This rejects the archive
 * the moment that running total exceeds `budget`, before the rest of the entry is ever
 * decompressed — the stream is paused as soon as the limit is crossed, so no further bytes are
 * produced past the excess already buffered in that one chunk.
 */
export function readEntryTextBounded(
  entry: JSZip.JSZipObject,
  budget: InflateBudget,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let settled = false;

    const stream = (entry as unknown as StreamingZipEntry).internalStream('text');
    stream
      .on('data', (chunk) => {
        if (settled) {
          return;
        }
        budget.remainingBytes -= Buffer.byteLength(chunk, 'utf8');
        if (budget.remainingBytes < 0) {
          settled = true;
          stream.pause();
          reject(
            new HostileArchiveException(
              `Archive entry "${entry.name}" inflated past the shared archive budget`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      })
      .on('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(chunks.join(''));
      })
      .resume();
  });
}
