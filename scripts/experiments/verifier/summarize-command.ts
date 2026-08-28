import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseWorksheet } from './parse-worksheet';
import { RUN_ARTEFACT, WORKSHEET_ARTEFACT, type RunRecord } from './run-experiment';
import { renderSummaryMarkdown, summarizeExperiment } from './summarize-experiment';

export const SUMMARY_ARTEFACT = 'summary.md';

/** The shape `cli.ts` loads this module under, without importing its value graph. */
export type SummarizeCommandModule = {
  readonly summarizeCommand: (runDir: string) => Promise<boolean>;
};

/**
 * Reads a run's record and its hand-filled worksheet and writes the result section.
 *
 * Imports nothing from the Nest graph deliberately: adjudication happens days after the run, and a
 * summary that needed a database, an API key and a booted container to add up two counts would be
 * one more reason for the result never to get written down.
 *
 * Returns `false` — and the caller exits nonzero — while the result is not yet the pre-registered
 * one: a malformed worksheet, an unadjudicated sample, or a section for a claim that was never
 * sampled. A silent exit 0 there would read as a completed experiment.
 */
export async function summarizeCommand(runDir: string): Promise<boolean> {
  const record = JSON.parse(await readFile(path.join(runDir, RUN_ARTEFACT), 'utf-8')) as RunRecord;
  const worksheetMarkdown = await readFile(path.join(runDir, WORKSHEET_ARTEFACT), 'utf-8');
  const worksheet = parseWorksheet(worksheetMarkdown);

  const summary = summarizeExperiment({
    runId: record.runId,
    gitSha: record.gitSha,
    tenantId: record.tenantId,
    totalClaims: record.totalClaims,
    breakdown: record.breakdown,
    sample: record.sample,
    rows: worksheet.rows,
  });

  const markdown = renderSummaryMarkdown(summary);
  await writeFile(path.join(runDir, SUMMARY_ARTEFACT), markdown, 'utf-8');
  console.log(markdown);

  for (const error of worksheet.errors) {
    console.error(`verifier: worksheet error — ${error.message}`);
  }

  return (
    worksheet.errors.length === 0 && summary.bar2 !== null && summary.unknownClaimIds.length === 0
  );
}
