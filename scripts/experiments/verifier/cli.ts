import { createRequire } from 'node:module';
import path from 'node:path';
import type { RunCommandModule } from './run-command';
import type { SummarizeCommandModule } from './summarize-command';

/**
 * Harness for the pre-registered verifier experiment. Its bars and reporting rules are fixed in
 * advance of any run.
 *
 *   npm run experiment:verifier -- run [--tenant <id>] [--claims-per-document <n>] [--seed <n>]
 *   npm run experiment:verifier -- summarize --run <dir>
 *
 * `run` drafts claims about an already-ingested corpus, puts them through
 * `ClaimVerificationService.verifyClaims`, and writes the run's artefacts — including the
 * adjudication worksheet a person fills in by hand. `summarize` reads the filled worksheet back and
 * computes the two pre-registered rates. The two are separate commands because a human step sits
 * between them.
 *
 * Each command's implementation is imported only on the branch that runs it: `run` pulls in the
 * whole Nest graph (and therefore `.env`, Mongo and an API key), and `summarize` must stay usable
 * without any of it.
 *
 * Output goes under `.tmp/`, which `.gitignore` excludes: a run's artefacts carry corpus text and
 * are working material for one adjudication, not a tracked deliverable.
 */

const DEFAULT_TENANT_ID = 'eval';
const DEFAULT_OUTPUT_ROOT = '.tmp/experiments/verifier';

/**
 * Claims drafted per document. Nine documents at this quota put the run near 108 claims, where one
 * claim moves the measured rate by under a point and the standard error at the 20% bar is about 4
 * points — enough resolution to tell a rate near the bar from one far below it. It also puts the
 * expected gate-failure count at the 20-claim adjudication cap, so the hand-adjudicated sample is
 * as large as the pre-registration allows.
 */
const DEFAULT_CLAIMS_PER_DOCUMENT = 12;

/** Fixed rather than time-derived: the same failure set must draw the same sample on a re-run. */
const DEFAULT_SAMPLE_SEED = 1729;

/**
 * Loads a command module on the branch that runs it, keeping the type-only imports above erased at
 * emit. A CommonJS load, not `await import()`: this file runs under `tsconfig.ts-node.json`
 * (`module: commonjs`), where TypeScript leaves a dynamic import as a real ESM import that would
 * need a `.js` specifier no `.ts` source on disk answers to.
 */
const loadModule = createRequire(__filename);

function usage(): never {
  console.error('usage: cli.ts run [--tenant <id>] [--claims-per-document <n>] [--seed <n>]');
  console.error('                 [--out <dir>] [--run-id <id>]');
  console.error('       cli.ts summarize --run <dir>');
  process.exit(1);
}

function readNumberFlag(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value)) {
    console.error(`${flag} needs a number`);
    usage();
  }
  return value;
}

function readStringFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === 'run') {
    const { runCommand } = loadModule('./run-command') as RunCommandModule;
    await runCommand({
      tenantId: readStringFlag(argv, '--tenant') ?? DEFAULT_TENANT_ID,
      claimsPerDocument: readNumberFlag(argv, '--claims-per-document', DEFAULT_CLAIMS_PER_DOCUMENT),
      seed: readNumberFlag(argv, '--seed', DEFAULT_SAMPLE_SEED),
      outputRoot: readStringFlag(argv, '--out') ?? DEFAULT_OUTPUT_ROOT,
      runId: readStringFlag(argv, '--run-id'),
    });
    return;
  }

  if (command === 'summarize') {
    const runDir = readStringFlag(argv, '--run');
    if (!runDir) {
      usage();
    }
    const { summarizeCommand } = loadModule('./summarize-command') as SummarizeCommandModule;
    if (!(await summarizeCommand(path.resolve(runDir)))) {
      process.exitCode = 1;
    }
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? `verifier: fatal error — ${error.message}\n${error.stack}` : error,
  );
  process.exitCode = 1;
});
