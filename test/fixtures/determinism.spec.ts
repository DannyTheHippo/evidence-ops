import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { generateDataRoom } from '../../scripts/fixtures/generate-data-room';
import { sha256Hex } from '../../scripts/fixtures/lib/hash';

const COMMITTED_DIR = path.join(__dirname, '../../fixtures/data-room');

/**
 * Determinism is the corpus's hard requirement (same input → byte-identical output). This
 * spec is the acceptance proof: generate twice into throwaway directories and diff sha256
 * sets, then diff against the committed fixtures so a hand-edited or stale commit is caught
 * too. Everything compared here runs on the machine that invoked the test — cross-machine
 * byte-identity is not claimed (jszip's DOS-time zip entries are written in local time; see
 * scripts/fixtures/lib/repack-zip.ts).
 */
describe('generateDataRoom determinism', () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('should produce byte-identical output across two independent runs', async () => {
    const runA = await mkdtemp(path.join(os.tmpdir(), 'eo-fixtures-a-'));
    const runB = await mkdtemp(path.join(os.tmpdir(), 'eo-fixtures-b-'));
    tempDirs.push(runA, runB);

    await generateDataRoom(runA);
    await generateDataRoom(runB);

    const filesA = (await readdir(runA)).sort();
    const filesB = (await readdir(runB)).sort();
    expect(filesA).toEqual(filesB);

    for (const fileName of filesA) {
      const bufferA = await readFile(path.join(runA, fileName));
      const bufferB = await readFile(path.join(runB, fileName));
      expect(sha256Hex(bufferA)).toBe(sha256Hex(bufferB));
    }
  });

  it('should match the committed fixtures/data-room corpus byte-for-byte', async () => {
    const generatedDir = await mkdtemp(path.join(os.tmpdir(), 'eo-fixtures-committed-'));
    tempDirs.push(generatedDir);

    await generateDataRoom(generatedDir);

    const committedFiles = (await readdir(COMMITTED_DIR)).sort();
    const generatedFiles = (await readdir(generatedDir)).sort();
    expect(generatedFiles).toEqual(committedFiles);

    for (const fileName of committedFiles) {
      const committed = await readFile(path.join(COMMITTED_DIR, fileName));
      const generated = await readFile(path.join(generatedDir, fileName));
      expect(sha256Hex(generated)).toBe(sha256Hex(committed));
    }
  });
});
