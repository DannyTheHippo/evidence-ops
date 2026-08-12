/** One discovered file under a source's root, as reported by `SourceConnector.listFiles`. */
export interface SourceConnectorFile {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/**
 * Reads a `Source`'s backing storage. `kind: 'local-folder'` on the `Source` schema selects
 * `LocalFolderSourceConnector`; a future `kind` would bind a different implementation behind the
 * same token. The sync service and workflow that call this interface are later steps, not part
 * of this port.
 */
export interface SourceConnector {
  listFiles(relativePath: string): Promise<SourceConnectorFile[]>;
  fetchFile(relativePath: string): Promise<Buffer>;
}

export const SOURCE_CONNECTOR = Symbol('SOURCE_CONNECTOR');
