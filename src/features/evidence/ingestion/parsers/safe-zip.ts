import { HttpStatus } from '@nestjs/common';
import type JSZip from 'jszip';
import { BaseException } from '../../../../shared/exceptions/base.exception';

/**
 * Shared zip hardening for the OOXML parsers. DOCX and XLSX are both zip+XML containers and carry
 * exactly the same archive-level risks, so the guard lives here once: two copies of security code
 * drift, and the copy that does not get the fix is the one an attacker finds.
 */

// A legitimate office document is a few dozen small XML parts. These sit far above that and exist
// only to bound what a hostile archive can cost us.
const MAX_ZIP_ENTRIES = 2000;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

/**
 * The ceiling `readEntryTextBounded` enforces against real, observed decompressed bytes — not the
 * archive's own declared sizes. Every part read through it is OOXML text (a `document.xml`, a
 * slide, a relationship file), never the multi-hundred-MB media payloads the declared caps above
 * exist to bound, so this sits far below them on purpose.
 */
const MAX_INFLATED_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Input gate: fails CLOSED. Any entry-count, size, ratio, or path violation rejects the whole
 * archive rather than handing a partially-checked buffer to a parser.
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
 * Runs entirely off the central directory's declared sizes, before any entry is inflated.
 *
 * **Known limit, deliberately accepted:** the declared sizes come from the archive itself, so a
 * crafted zip can under-report them and slip past these caps, and the real cost is only paid when
 * an entry is decompressed. That is why this is not the only control — the upload endpoint caps
 * the compressed payload before a parser ever sees it, which bounds the worst case. Treat this as
 * a cheap first filter, not a decompression-bomb proof.
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

    const declared = (entry as unknown as DeclaredZipEntrySize)._data;
    const uncompressedSize = declared?.uncompressedSize ?? 0;
    const compressedSize = declared?.compressedSize ?? 0;

    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new HostileArchiveException(
        `Archive entry "${entry.name}" declares ${uncompressedSize} uncompressed bytes, exceeding the ${MAX_ENTRY_UNCOMPRESSED_BYTES} limit`,
      );
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new HostileArchiveException(
        `Archive entry "${entry.name}" has a ${Math.round(uncompressedSize / compressedSize)}:1 compression ratio, exceeding the ${MAX_COMPRESSION_RATIO}:1 limit`,
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
  readonly internalStream: (type: 'text') => JSZip.JSZipStreamHelper<string>;
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
