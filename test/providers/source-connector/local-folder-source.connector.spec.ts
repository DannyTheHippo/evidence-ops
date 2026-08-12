import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourcePathEscapesRootError } from '../../../src/providers/source-connector/errors/source-path-escapes-root.error';
import { LocalFolderSourceConnector } from '../../../src/providers/source-connector/local-folder-source.connector';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

describe('LocalFolderSourceConnector', () => {
  let root: string;
  let outsideRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evidence-ops-source-root-'));
    outsideRoot = await mkdtemp(join(tmpdir(), 'evidence-ops-source-outside-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  function buildConnector(): LocalFolderSourceConnector {
    return new LocalFolderSourceConnector(
      getMockTypedConfig({ sources: { inboxDir: root, syncIntervalMs: 300000 } }),
    );
  }

  describe('listFiles', () => {
    it('should list files recursively, sorted by relativePath', async () => {
      await writeFile(join(root, 'b.txt'), 'b');
      await mkdir(join(root, 'sub'));
      await writeFile(join(root, 'sub', 'a.txt'), 'a');

      const files = await buildConnector().listFiles('');

      expect(files.map((f) => f.relativePath)).toEqual(['b.txt', 'sub/a.txt']);
    });

    it('should skip directory entries rather than including them as files', async () => {
      await mkdir(join(root, 'empty-dir'));
      await writeFile(join(root, 'file.txt'), 'x');

      const files = await buildConnector().listFiles('');

      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('file.txt');
    });

    it('should report sizeBytes and mtimeMs for each file', async () => {
      await writeFile(join(root, 'sized.txt'), 'hello');

      const [file] = await buildConnector().listFiles('');

      expect(file.sizeBytes).toBe(5);
      expect(file.mtimeMs).toBeGreaterThan(0);
    });

    it('should produce identical ordering across repeated calls over an unchanged folder', async () => {
      await writeFile(join(root, 'z.txt'), 'z');
      await writeFile(join(root, 'a.txt'), 'a');
      await writeFile(join(root, 'm.txt'), 'm');
      const connector = buildConnector();

      const first = await connector.listFiles('');
      const second = await connector.listFiles('');

      expect(first.map((f) => f.relativePath)).toEqual(['a.txt', 'm.txt', 'z.txt']);
      expect(second.map((f) => f.relativePath)).toEqual(first.map((f) => f.relativePath));
    });
  });

  describe('fetchFile', () => {
    it('should return the file contents as a Buffer', async () => {
      await writeFile(join(root, 'doc.txt'), 'contents');

      const buffer = await buildConnector().fetchFile('doc.txt');

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString('utf8')).toBe('contents');
    });

    it('should read a nested file by its relative path', async () => {
      await mkdir(join(root, 'nested'));
      await writeFile(join(root, 'nested', 'doc.txt'), 'nested-contents');

      const buffer = await buildConnector().fetchFile('nested/doc.txt');

      expect(buffer.toString('utf8')).toBe('nested-contents');
    });
  });

  describe('path containment', () => {
    it('should reject "../" traversal that walks the path out of the root', async () => {
      // Attack: relativePath = '../secret.txt' escapes the root by climbing one level before descending into a sibling directory.
      await writeFile(join(outsideRoot, 'secret.txt'), 'secret');

      await expect(buildConnector().fetchFile('../secret.txt')).rejects.toBeInstanceOf(
        SourcePathEscapesRootError,
      );
    });

    it('should reject an absolute path even when it points inside the root', async () => {
      // Attack: relativePath is an absolute filesystem path, bypassing the "relative to root" contract entirely.
      await writeFile(join(root, 'inside.txt'), 'inside');

      await expect(buildConnector().fetchFile(join(root, 'inside.txt'))).rejects.toBeInstanceOf(
        SourcePathEscapesRootError,
      );
    });

    it('should reject a path that lexically normalizes back out of the root', async () => {
      // Attack: relativePath = 'a/../../etc/passwd' looks contained token-by-token but two ".." segments walk past the root once "a" cancels out.
      await expect(buildConnector().fetchFile('a/../../etc/passwd')).rejects.toBeInstanceOf(
        SourcePathEscapesRootError,
      );
    });

    it('should reject a symlink inside the root whose real target resolves outside it', async () => {
      // Attack: relativePath = 'link.txt' is lexically contained, but the entry is a symlink whose real target lives outside the root — a lexical-only check would pass this.
      await writeFile(join(outsideRoot, 'target.txt'), 'outside-contents');
      await symlink(join(outsideRoot, 'target.txt'), join(root, 'link.txt'));

      await expect(buildConnector().fetchFile('link.txt')).rejects.toBeInstanceOf(
        SourcePathEscapesRootError,
      );
    });

    it('should reject listFiles on a directory symlink whose real target resolves outside the root', async () => {
      // Attack: relativePath = 'linked-dir' names a directory symlink so listing would otherwise walk an arbitrary directory outside the root.
      await mkdir(join(outsideRoot, 'dir'));
      await symlink(join(outsideRoot, 'dir'), join(root, 'linked-dir'), 'dir');

      await expect(buildConnector().listFiles('linked-dir')).rejects.toBeInstanceOf(
        SourcePathEscapesRootError,
      );
    });

    it('should allow a symlink inside the root whose real target also resolves inside it', async () => {
      await writeFile(join(root, 'real.txt'), 'real-contents');
      await symlink(join(root, 'real.txt'), join(root, 'link.txt'));

      const buffer = await buildConnector().fetchFile('link.txt');

      expect(buffer.toString('utf8')).toBe('real-contents');
    });
  });
});
