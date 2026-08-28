// The Compound File Binary header every legacy Office format (`.doc`, `.xls`, `.ppt`) and every
// *encrypted* OOXML file (`.docx`/`.xlsx` wrapped for password protection, which Office re-containers
// as CFB rather than leaving as a plain zip) starts with. `documents.constant.ts`'s
// `contentMatchesDeclaredKind` sniffs for the PDF and ZIP magic bytes only — this signature is
// neither, so a file starting with it fails that sniff exactly as the real thing would, without this
// fixture needing to reproduce a genuine CFB directory structure.
const CFB_MAGIC_BYTES = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

// Padded past the magic so the stub is not a truncated-file edge case in its own right — large
// enough to look like a real minimal CFB sector (512 bytes is CFB's standard sector size) without
// attempting a real compound-file directory.
const STUB_TOTAL_BYTES = 512;

/**
 * A byte-faithful CFB-container stub, named per caller as `.docx` (an "encrypted DOCX" — real
 * password-protected OOXML is a CFB container, not a zip, until unlocked) or as legacy `.doc`/`.xls`
 * (both genuinely CFB-based formats this project never supported). `label` only selects the filler
 * byte pattern, which is otherwise inert — it exists so two stubs built for two different fixture
 * paths are not byte-identical, which would make them collide as sha256 duplicates in
 * `SourcesService.syncOneFile`'s per-path dedupe the way `duplicates/**` is deliberately made to.
 */
export function buildCfbStub(label: string): Buffer {
  const labelBytes = Buffer.from(label, 'utf-8');
  const fillerLength = STUB_TOTAL_BYTES - CFB_MAGIC_BYTES.length;
  const filler = Buffer.alloc(fillerLength);
  // Cycles the full label through the filler rather than repeating one byte
  // (`label.charCodeAt(0)` would do that, and collapses two labels sharing a first character —
  // e.g. 'legacy-doc' and 'legacy-xls' — to byte-identical stubs) so any two distinct labels
  // reliably produce distinct fixtures.
  for (let i = 0; i < fillerLength; i += 1) {
    filler[i] = labelBytes[i % labelBytes.length];
  }
  return Buffer.concat([CFB_MAGIC_BYTES, filler]);
}
