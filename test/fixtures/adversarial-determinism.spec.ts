import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { generateAdversarialTree } from '../../scripts/fixtures/adversarial/generate-adversarial-tree';
import { sha256Hex } from '../../scripts/fixtures/lib/hash';

const COMMITTED_DIR = path.join(__dirname, '../../fixtures/adversarial');

/** Recursively lists every file under `dir`, relative to `dir`, in a stable sorted order — the
 *  adversarial tree nests `duplicates/folder-a|b/**`, unlike the flat data-room tree, so a plain
 *  `readdir` (mirroring `determinism.spec.ts`) is not enough here. */
async function listFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await listFilesRecursively(entryPath);
        return nested.map((relative) => path.join(entry.name, relative));
      }
      return [entry.name];
    }),
  );
  return files.flat().sort();
}

/**
 * Mirrors `determinism.spec.ts`'s two proofs for the adversarial tree: two independent generator
 * runs are byte-identical, and the committed corpus matches what the generator produces right now.
 */
describe('generateAdversarialTree determinism', () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('should produce byte-identical output across two independent runs', async () => {
    const runA = await mkdtemp(path.join(os.tmpdir(), 'eo-adversarial-a-'));
    const runB = await mkdtemp(path.join(os.tmpdir(), 'eo-adversarial-b-'));
    tempDirs.push(runA, runB);

    await generateAdversarialTree(runA);
    await generateAdversarialTree(runB);

    const filesA = await listFilesRecursively(runA);
    const filesB = await listFilesRecursively(runB);
    expect(filesA).toEqual(filesB);

    for (const relativePath of filesA) {
      const bufferA = await readFile(path.join(runA, relativePath));
      const bufferB = await readFile(path.join(runB, relativePath));
      expect(sha256Hex(bufferA)).toBe(sha256Hex(bufferB));
    }
  });

  it('should match the committed fixtures/adversarial corpus byte-for-byte', async () => {
    const generatedDir = await mkdtemp(path.join(os.tmpdir(), 'eo-adversarial-committed-'));
    tempDirs.push(generatedDir);

    await generateAdversarialTree(generatedDir);

    const committedFiles = await listFilesRecursively(COMMITTED_DIR);
    const generatedFiles = await listFilesRecursively(generatedDir);
    expect(generatedFiles).toEqual(committedFiles);

    for (const relativePath of committedFiles) {
      const committed = await readFile(path.join(COMMITTED_DIR, relativePath));
      const generated = await readFile(path.join(generatedDir, relativePath));
      expect(sha256Hex(generated)).toBe(sha256Hex(committed));
    }
  });
});
