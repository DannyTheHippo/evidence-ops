/** Renders a byte count the way a reader expects a file size, not the raw integer the API sends:
 * whole bytes below 1 KB, one decimal place from KB up through GB. `sizeBytes` is a stored file's
 * byte length and never negative, so a negative input is not handled. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // toFixed(1) can round a value just under 1024 up to "1024.0" (e.g. 1048575 B) — promote once
  // more so the rendered number always stays under 1000.
  if (Number(value.toFixed(1)) >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
