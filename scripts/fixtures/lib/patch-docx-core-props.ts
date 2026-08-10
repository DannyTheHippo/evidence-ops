import { FIXED_DOCUMENT_DATE } from './constants';

const CORE_PROPS_ENTRY = 'docProps/core.xml';

const TIMESTAMP_TAG_PATTERN = (tag: 'created' | 'modified'): RegExp =>
  new RegExp(`(<dcterms:${tag}[^>]*>)[^<]*(</dcterms:${tag}>)`);

/**
 * The `docx` package's CoreProperties constructor calls `new Date()` directly for both
 * dcterms:created and dcterms:modified with no way to override it (see docx source:
 * src/file/core-properties/properties.ts, TimestampElement). Post-process the generated
 * docProps/core.xml to pin both to a fixed instant before the zip repack, otherwise the
 * document is non-deterministic no matter what happens at the zip-entry level.
 */
export const patchDocxCoreProps: (entryName: string, content: Buffer) => Buffer = (
  entryName,
  content,
) => {
  if (entryName !== CORE_PROPS_ENTRY) {
    return content;
  }
  const iso = FIXED_DOCUMENT_DATE.toISOString();
  const patched = content
    .toString('utf-8')
    .replace(TIMESTAMP_TAG_PATTERN('created'), `$1${iso}$2`)
    .replace(TIMESTAMP_TAG_PATTERN('modified'), `$1${iso}$2`);
  return Buffer.from(patched, 'utf-8');
};
