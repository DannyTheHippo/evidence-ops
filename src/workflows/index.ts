/**
 * Bundler entrypoint. `Worker.create`'s `workflowsPath` (`src/worker/main.ts`) and
 * `bundleWorkflowCode` both discover workflow functions by `require`-ing this file — only what
 * is re-exported here is visible to the worker, per the SDK's bundler.
 */
export { ingestDocumentVersion } from './ingest-document-version.workflow';
