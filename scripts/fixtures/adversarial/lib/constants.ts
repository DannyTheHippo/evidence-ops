export { DOCUMENT_AUTHOR, FIXED_DOCUMENT_DATE } from '../../lib/constants';

/**
 * The property this tree exercises: `SourcesService.runSync` must leave every file here in a
 * visible terminal state — ingested, or listed against its source with a `lastError` — never
 * silently retried forever with no operator-visible record. Each fixture below targets one
 * hardening path landed across ingestion, sources, and the chunker; `build-manifest.ts` records
 * what each one is expected to do so `test/fixtures/adversarial-tree.spec.ts` can check the
 * property over the whole tree rather than one assertion per fixture.
 */
export const ADVERSARIAL_TREE_PURPOSE =
  'Exercises the sync-path and parser hardening landed in this cycle against a reproducible, ' +
  'non-real-estate-data fixture tree.';
