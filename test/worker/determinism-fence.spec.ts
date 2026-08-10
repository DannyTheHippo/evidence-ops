import { bundleWorkflowCode } from '@temporalio/worker';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The authoritative half of the determinism fence (ADR-0003; see `eslint.config.mjs`'s
 * `src/workflows/**` block and `test/eslint/determinism-fence.spec.ts` for the fast-signal half).
 * `bundleWorkflowCode` is the same webpack bundling `Worker.create` runs at boot
 * (`src/worker/main.ts`) — it resolves the whole module graph on disk, so it catches a Node
 * builtin or forbidden module reached transitively through a third-party package, which the
 * ESLint rule structurally can't see (it only pattern-matches an import statement's own
 * specifier). No network or running Temporal server is needed here: bundling is pure local
 * webpack, unlike `NativeConnection.connect` in `main.ts`.
 */
describe('determinism fence — bundleWorkflowCode', () => {
  it('bundles the real workflow tree (ingestDocumentVersion, answerQuestion) cleanly', async () => {
    const bundle = await bundleWorkflowCode({
      workflowsPath: join(__dirname, '..', '..', 'src', 'workflows', 'index.ts'),
    });

    expect(bundle.code.length).toBeGreaterThan(0);
  }, 30000);

  /**
   * Two files identical but for the import, so the rejection is attributable to the forbidden
   * module rather than to anything about bundling a scratch file.
   *
   * The thrown message is only "Webpack finished with errors …" — the offending module name lives
   * in webpack's error detail, not the top-level message. Matching loosely on that string alone
   * would let any unrelated bundling failure masquerade as proof the fence works, so the control
   * case is what makes this assertion mean something.
   */
  it('rejects a forbidden import while an allowed one bundles from the same scratch dir', async () => {
    // Inside the repo, not os.tmpdir(): webpack resolves bare specifiers by walking up for
    // node_modules, so a probe file under /tmp cannot resolve `@temporalio/workflow` at all and
    // fails for a reason that has nothing to do with the fence. `.temporal/` is already
    // gitignored (it holds the dev server's db), so this leaves no tracked residue.
    const scratchRoot = join(__dirname, '..', '..', '.temporal');
    mkdirSync(scratchRoot, { recursive: true });
    const dir = mkdtempSync(join(scratchRoot, 'determinism-fence-'));

    const write = (name: string, importLine: string): string => {
      const file = join(dir, name);
      writeFileSync(
        file,
        [
          importLine,
          '',
          'export async function probe(): Promise<string> {',
          "  return 'ok';",
          '}',
          '',
        ].join('\n'),
      );
      return file;
    };

    const forbidden = write('forbidden.workflow.ts', "import 'mongoose';");
    const allowed = write('allowed.workflow.ts', "import { sleep } from '@temporalio/workflow';");

    try {
      // Control first: if this fails, the scratch-dir setup is broken and the rejection below
      // would prove nothing.
      const bundle = await bundleWorkflowCode({ workflowsPath: allowed });
      expect(bundle.code.length).toBeGreaterThan(0);

      await expect(bundleWorkflowCode({ workflowsPath: forbidden })).rejects.toThrow(
        /Webpack finished with errors/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
