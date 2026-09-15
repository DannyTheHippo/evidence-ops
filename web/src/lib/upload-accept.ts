/**
 * Mirrors the extensions in the API's `UPLOAD_EXTENSION_ALLOWLIST`
 * (`src/features/evidence/documents/documents.constant.ts`) so an upload control can reject an
 * obviously unsupported file before it ever reaches the network. The server stays the authority —
 * it re-derives the kind from content, not the extension alone, and this precheck never replaces
 * that gate, only spares a user the round trip for the common miss.
 */
export const UPLOAD_ACCEPT = '.pdf,.docx,.xlsx,.pptx,.csv,.tsv,.txt,.md,.eml,.html,.htm';

const UPLOAD_ACCEPT_EXTENSIONS: ReadonlySet<string> = new Set(
  UPLOAD_ACCEPT.split(',').map((ext) => ext.slice(1)),
);

/** Matches the API's `MAX_FILE_SIZE_BYTES` (`documents.constant.ts`). */
export const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024;

function lowercaseExtension(filename: string): string | undefined {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === filename.length - 1) return undefined;
  return filename.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * Client-side precheck for a file about to be uploaded: an unsupported extension or a file over
 * the size cap returns a message to show the user; a file that passes returns `null`. Never the
 * final word — the upload can still fail server-side on a mismatched declared type.
 */
export function precheckUploadFile(file: { name: string; size: number }): string | null {
  const extension = lowercaseExtension(file.name);
  if (!extension || !UPLOAD_ACCEPT_EXTENSIONS.has(extension)) return 'Unsupported file type.';
  if (file.size > MAX_UPLOAD_SIZE_BYTES) return 'File exceeds the 50 MB limit.';
  return null;
}
