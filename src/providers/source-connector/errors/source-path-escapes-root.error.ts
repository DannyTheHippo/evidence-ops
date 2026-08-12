/**
 * Fails CLOSED — `LocalFolderSourceConnector` throws this rather than read a path that resolves
 * (lexically or, after following symlinks, via `realpath`) outside its configured root, so a
 * `relativePath` an attacker controls can never reach a file the source was not configured to
 * expose.
 */
export class SourcePathEscapesRootError extends Error {
  constructor(public readonly relativePath: string) {
    super(`Source path "${relativePath}" resolves outside the configured source root`);
    this.name = 'SourcePathEscapesRootError';
  }
}
