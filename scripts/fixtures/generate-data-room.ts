import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildCompsSheet } from './lib/build-comps-sheet';
import { buildLeaseSummary } from './lib/build-lease-summary';
import { buildManifest } from './lib/build-manifest';
import { buildMarketOverview } from './lib/build-market-overview';
import { buildValuationMemo } from './lib/build-valuation-memo';

/**
 * Generates the synthetic data-room fixtures into `targetDir`. Exported as a function (rather
 * than only a CLI script) so both the CLI entry point below and the determinism test
 * (test/fixtures/determinism.spec.ts) call the exact same code path.
 */
export async function generateDataRoom(targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });

  const [comps, valuationMemo, marketOverview, leaseSummary] = await Promise.all([
    buildCompsSheet(),
    buildValuationMemo(),
    buildMarketOverview(),
    buildLeaseSummary(),
  ]);

  const manifest = buildManifest({ comps, valuationMemo, marketOverview, leaseSummary });

  await Promise.all([
    writeFile(path.join(targetDir, 'comps.xlsx'), comps.buffer),
    writeFile(path.join(targetDir, 'valuation-memo.pdf'), valuationMemo.buffer),
    writeFile(path.join(targetDir, 'market-overview.pdf'), marketOverview.buffer),
    writeFile(path.join(targetDir, 'lease-summary.docx'), leaseSummary.buffer),
    // Trailing newline to match prettier/editorconfig conventions for committed JSON files.
    writeFile(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
}

// The CLI entrypoint deliberately lives in ./cli.ts. An `import.meta.url === argv[1]`
// run-as-main guard cannot compile under ts-jest's CommonJS transform, which is how the
// determinism spec imports this module — so the library stays import-only.
