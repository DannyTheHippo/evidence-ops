/**
 * Determinism fence, ESLint half (ADR-0003) — shared source of truth. `eslint.config.mjs`
 * imports this for the real `src/workflows/**` block; `test/eslint/determinism-fence.spec.ts`
 * `require()`s it directly to prove the rule rejects a deliberately-forbidden import, without
 * hand-copying the options (which could drift out of sync with what CI actually enforces).
 *
 * Plain CommonJS, not TypeScript: `eslint.config.mjs` is loaded by the `eslint` CLI with no
 * ts-node/tsx registration, so it can only import `.js`/`.cjs`/`.mjs` directly.
 *
 * This is a fast CI signal, not the guarantee — it can't see a Node builtin or a forbidden
 * module reached transitively through a third-party package. The worker's `bundleWorkflowCode`
 * is the authoritative gate; see `test/worker/determinism-fence.spec.ts`.
 */
module.exports = {
  noRestrictedImportsOptions: [
    'error',
    {
      paths: [
        {
          name: 'mongoose',
          message:
            'Workflow code must stay deterministic (ADR-0003) — database access belongs in an activity.',
        },
        {
          name: '@temporalio/client',
          message:
            'Workflow code must stay deterministic (ADR-0003) — the Temporal client belongs in the worker entrypoint, not a workflow.',
        },
        {
          name: '@temporalio/worker',
          message:
            'Workflow code must stay deterministic (ADR-0003) — the worker API belongs in the worker entrypoint, not a workflow.',
        },
      ],
      patterns: [
        {
          group: ['@nestjs/*'],
          message:
            'Workflow code must stay deterministic (ADR-0003) — NestJS DI resolves real services and belongs in an activity.',
        },
        {
          group: ['**/providers/**'],
          message:
            'Workflow code must stay deterministic (ADR-0003) — providers reach Mongo/vendor APIs and belong in an activity, not a workflow.',
        },
      ],
    },
  ],
};
