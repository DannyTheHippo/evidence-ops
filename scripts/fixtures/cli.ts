// MUST stay the first import: pins TZ=UTC before any other fixture module is evaluated.
import './lib/pin-timezone';

import path from 'node:path';
import { generateDataRoom } from './generate-data-room';

/**
 * CLI wrapper for the fixture generator. Kept separate from the module itself so the generator
 * stays importable by tests under ts-jest's CommonJS transform, where a run-as-main guard using
 * `import.meta` will not compile.
 */
const target = process.argv[2] ?? path.join(process.cwd(), 'fixtures', 'data-room');

generateDataRoom(target)
  .then(() => {
    console.log(`Data room fixtures written to ${target}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
