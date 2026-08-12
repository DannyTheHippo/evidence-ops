import { Injectable } from '@nestjs/common';
import type { SourceConnector, SourceConnectorFile } from './source-connector.interface';

interface FakeSourceFile {
  readonly content: Buffer;
  readonly mtimeMs: number;
}

/**
 * Test double for `SourceConnector`. Files are seeded via `addFile` rather than read from disk,
 * so specs and the e2e DI override can exercise a source's sync path without a real filesystem.
 */
@Injectable()
export class FakeSourceConnector implements SourceConnector {
  private readonly files = new Map<string, FakeSourceFile>();

  addFile(relativePath: string, content: Buffer, mtimeMs = Date.now()): void {
    this.files.set(relativePath, { content, mtimeMs });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async listFiles(relativePath: string): Promise<SourceConnectorFile[]> {
    const prefix = relativePath === '' ? '' : `${relativePath}/`;

    return [...this.files.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, file]) => ({
        relativePath: path,
        sizeBytes: file.content.length,
        mtimeMs: file.mtimeMs,
      }))
      .sort((a, b) =>
        a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
      );
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async fetchFile(relativePath: string): Promise<Buffer> {
    const file = this.files.get(relativePath);
    if (!file) {
      throw new Error(`FakeSourceConnector has no file at "${relativePath}"`);
    }

    return file.content;
  }
}
