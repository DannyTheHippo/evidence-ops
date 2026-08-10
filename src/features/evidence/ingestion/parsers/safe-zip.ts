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
