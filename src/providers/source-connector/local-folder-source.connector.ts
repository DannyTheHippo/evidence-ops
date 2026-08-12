import { Injectable } from '@nestjs/common';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { SourcePathEscapesRootError } from './errors/source-path-escapes-root.error';
import type { SourceConnector, SourceConnectorFile } from './source-connector.interface';

/**
 * `SourceConnector` for `kind: 'local-folder'`, rooted at `config.sources.inboxDir`. Every
 * `relativePath` passed to `listFiles`/`fetchFile` is resolved against that root and rejected —
 * via `SourcePathEscapesRootError` — unless it lands strictly inside the root once both a
 * lexical check (`../`, an absolute path, a normalization that walks back out) and a `realpath`
 * check (a symlink whose target lives outside the root) have passed. The `realpath` check is
 * what a lexical-only containment check misses: a symlink inside the root that points elsewhere
 * resolves lexically to an in-root path while its real target is outside it.
 */
@Injectable()
export class LocalFolderSourceConnector implements SourceConnector {
  private readonly root: string;

  constructor(config: TypedConfigService) {
    this.root = resolve(config.sources.inboxDir);
  }

  async listFiles(relativePath: string): Promise<SourceConnectorFile[]> {
    const startDir = await this.resolveContained(relativePath);
    const files = await this.walk(startDir);

    /**
     * Sorted by `relativePath` so two runs over an unchanged folder produce byte-identical
     * ordering — downstream ids derived from list position stay stable across sync passes.
     * Ordinal comparison, not `localeCompare`, keeps that ordering independent of the host's
     * locale.
     */
    return files.sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );
  }

  async fetchFile(relativePath: string): Promise<Buffer> {
    const fullPath = await this.resolveContained(relativePath);
    return readFile(fullPath);
  }

  /** Recurses into directories; directory entries themselves are not files and are not returned. */
  private async walk(dir: string): Promise<SourceConnectorFile[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: SourceConnectorFile[] = [];

    for (const entry of entries) {
      const entryPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await this.walk(entryPath)));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const entryStat = await stat(entryPath);
      files.push({
        relativePath: relative(this.root, entryPath),
        sizeBytes: entryStat.size,
        mtimeMs: entryStat.mtimeMs,
      });
    }

    return files;
  }

  /**
   * Resolves `relativePath` against `root` and enforces containment. Returns the resolved
   * (lexical, not real) path so a caller reads through the original — possibly symlinked —
   * location rather than a `realpath`-rewritten one; the `realpath` comparison here exists only
   * to detect an escape, never to substitute for the path it validates.
   */
  private async resolveContained(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) {
      throw new SourcePathEscapesRootError(relativePath);
    }

    const resolved = resolve(this.root, relativePath);
    const lexicalRel = relative(this.root, resolved);
    if (lexicalRel === '..' || lexicalRel.startsWith(`..${sep}`) || isAbsolute(lexicalRel)) {
      throw new SourcePathEscapesRootError(relativePath);
    }

    let resolvedReal: string;
    try {
      resolvedReal = await realpath(resolved);
    } catch {
      return resolved;
    }

    const rootReal = await realpath(this.root);
    const realRel = relative(rootReal, resolvedReal);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      throw new SourcePathEscapesRootError(relativePath);
    }

    return resolved;
  }
}
