// MUST stay the first import: pins TZ=UTC before any other fixture module is evaluated (see
// `lib/pin-timezone.ts`'s own doc comment).
import './lib/pin-timezone';

import path from 'node:path';
import { generateAdversarialTree } from './adversarial/generate-adversarial-tree';

/**
 * CLI wrapper for the adversarial fixture generator, mirroring `cli.ts` for the same reason: kept
 * separate from the generator module itself so the generator stays importable by tests under
 * ts-jest's CommonJS transform, where a run-as-main guard using `import.meta` will not compile.
 *
 * Run with `npx tsx scripts/fixtures/adversarial-cli.ts [targetDir]`.
 */
const target = process.argv[2] ?? path.join(process.cwd(), 'fixtures', 'adversarial');

generateAdversarialTree(target)
  .then(() => {
    console.log(`Adversarial fixtures written to ${target}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
