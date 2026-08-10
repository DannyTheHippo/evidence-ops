import JSZip from 'jszip';

import { FIXED_DOCUMENT_DATE } from './constants';

export type ZipEntryTransform = (entryName: string, content: Buffer) => Buffer;

/**
 * xlsx and docx are zip containers. Neither exceljs nor docx exposes a way to pin every
 * per-entry mtime the underlying zip writer stamps with `new Date()`, so two generator runs
 * produce byte-different files even with identical content and identical workbook/document
 * metadata. Rebuilding the zip ourselves — sorted entry order, one fixed date, one fixed
 * compression setting — removes that source of drift. `transform` exists for docx's
 * docProps/core.xml, whose created/modified timestamps the `docx` package hardcodes to
 * `new Date()` with no override option (see docx source: CoreProperties constructor).
 */
export async function repackDeterministicZip(
  source: Buffer,
  transform?: ZipEntryTransform,
): Promise<Buffer> {
  const original = await JSZip.loadAsync(source);
  const rebuilt = new JSZip();

  // Sorted order removes both the origin library's insertion order and any platform-dependent
  // directory-iteration order from the output, on top of the fixed per-entry date below.
  const entryNames = Object.keys(original.files).sort();

  for (const name of entryNames) {
    const entry = original.files[name];
    if (entry.dir) {
      // `folder()` takes no options, so jszip stamps the directory entry with `new Date()` —
      // the one unpinned clock read left in the pipeline. DOS timestamps have two-second
      // granularity, so this only diverges when two runs straddle a boundary: reliably green
      // in a fast loop, red in a slow suite. Set the date explicitly instead.
      rebuilt.file(name, '', { dir: true, date: FIXED_DOCUMENT_DATE });
      continue;
    }
    const raw = await entry.async('nodebuffer');
    const content = transform ? transform(name, raw) : raw;
    rebuilt.file(name, content, { date: FIXED_DOCUMENT_DATE });
  }

  return rebuilt.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}
