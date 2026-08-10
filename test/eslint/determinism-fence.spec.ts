import { Linter } from 'eslint';

/**
 * `require()`s the exact options `eslint.config.mjs`'s `src/workflows/**\/*.ts` block uses
 * (`eslint-rules/determinism-fence.cjs`), rather than a hand-copied duplicate, so this test can't
 * drift out of sync with what CI actually enforces.
 *
 * A bare `require()` call (not `import`, and not the TS-specific `import x = require(...)`) is
 * untyped by design — `tsc` never attempts to resolve or type the target module for it, which
 * sidesteps two real constraints: `allowJs` is off project-wide, and `.cjs` isn't part of any
 * tsconfig `include`. The shape is validated at runtime instead, right below.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see the doc comment above
const determinismFence: unknown = require('../../eslint-rules/determinism-fence.cjs');

function getRuleOptions(): Linter.RuleEntry {
  if (
    typeof determinismFence !== 'object' ||
    determinismFence === null ||
    !('noRestrictedImportsOptions' in determinismFence)
  ) {
    throw new Error(
      "eslint-rules/determinism-fence.cjs no longer exports 'noRestrictedImportsOptions'",
    );
  }

  return determinismFence.noRestrictedImportsOptions as Linter.RuleEntry;
}

/**
 * Half one of the determinism fence (ADR-0003) — the fast CI signal, not the guarantee. It can't
 * see a Node builtin or a forbidden module reached transitively through a third-party package;
 * `test/worker/determinism-fence.spec.ts` proves the authoritative half (the worker's
 * `bundleWorkflowCode`) rejects that case instead.
 */
describe('determinism fence — ESLint no-restricted-imports over src/workflows/**', () => {
  const ruleOptions = getRuleOptions();

  function lint(code: string): Linter.LintMessage[] {
    const linter = new Linter({ configType: 'flat' });
    const config: Linter.Config = {
      // `files` is load-bearing: under flat config a config object with no `files` still does not
      // match a `.ts` path, so `verify` returns a single "No matching configuration found"
      // message and lints nothing — which reads exactly like "the rule did not fire".
      files: ['**/*.ts'],
      languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
      rules: { 'no-restricted-imports': ruleOptions },
    };

    return linter.verify(code, config, 'src/workflows/example.workflow.ts');
  }

  it.each([
    "import { Injectable } from '@nestjs/common';",
    "import { Types } from 'mongoose';",
    "import { Client } from '@temporalio/client';",
    "import { Worker } from '@temporalio/worker';",
    "import { WORKFLOW_ENGINE } from '../providers/workflow-engine/workflow-engine.interface';",
  ])('rejects %s', (statement) => {
    const messages = lint(statement);

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('allows @temporalio/workflow, the SDK the real workflow needs', () => {
    const messages = lint("import { proxyActivities } from '@temporalio/workflow';");

    expect(messages).toHaveLength(0);
  });
});
