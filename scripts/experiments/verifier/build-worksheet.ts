import type { AdjudicationSample, ClaimContext, ClaimOutcome, VerdictBreakdown } from './types';
import { formatLocator, SOURCE_FENCE, VERIFIER_SHORTLIST_SIZE } from './worksheet-format';

export interface WorksheetInput {
  readonly runId: string;
  readonly gitSha: string;
  readonly tenantId: string;
  readonly totalClaims: number;
  readonly breakdown: VerdictBreakdown;
  readonly sample: AdjudicationSample;
  /** The sampled claims, in the order they are to be adjudicated. */
  readonly sampled: readonly ClaimOutcome[];
  /** Retrieval context per sampled claim, keyed by `claimId`. */
  readonly contexts: readonly ClaimContext[];
  /** Every filename in the corpus, so an adjudicator knows the full set a `false_catch` could hide in. */
  readonly corpusFilenames: readonly string[];
}

function buildHeader(input: WorksheetInput): string {
  const failures = input.breakdown.not_grounded + input.breakdown.no_evidence_retrieved;
  return [
    '# Adjudication worksheet — verifier experiment',
    '',
    `- Run: \`${input.runId}\``,
    `- Git sha: \`${input.gitSha}\``,
    `- Tenant: \`${input.tenantId}\``,
    `- Claims drafted: ${input.totalClaims}`,
    `- Verdicts: grounded ${input.breakdown.grounded}, not_grounded ${input.breakdown.not_grounded}, ` +
      `no_evidence_retrieved ${input.breakdown.no_evidence_retrieved}, ` +
      `conflicting_evidence ${input.breakdown.conflicting_evidence}`,
    `- Gate failures (not_grounded + no_evidence_retrieved): ${failures}`,
    `- Sampled for adjudication: ${input.sample.claimIds.length} of ${input.sample.populationSize} ` +
      `(seed ${input.sample.seed})`,
    '',
    '## How to fill this in',
    '',
    'Put exactly one of these on every `Adjudication:` line below:',
    '',
    '- `correct_catch` — the claim genuinely is not supported by the corpus.',
    '- `false_catch` — the evidence is there and the gate failed to find it.',
    '',
    'Leave the `Note:` line for anything a reader of the result would need to follow the judgement.',
    'Do not edit the `### claim <id>` headings or the field labels — the summary command parses them.',
    '',
    `The excerpts under each claim are what this tenant's retrieval returned for that claim, in rank`,
    `order. The verifying model is shown only the first ${VERIFIER_SHORTLIST_SIZE}. Evidence that`,
    'retrieval never surfaced is still evidence: a `false_catch` may rest on a passage absent from',
    'the excerpts, so check the source files where the claim is plausible but unsupported here.',
    '',
    `Corpus files: ${input.corpusFilenames.map((name) => `\`${name}\``).join(', ')}`,
    '',
  ].join('\n');
}

function buildEvidenceSection(context: ClaimContext | undefined): readonly string[] {
  if (!context || context.hits.length === 0) {
    return ['**Retrieved evidence**', '', '_Retrieval returned nothing for this claim._', ''];
  }

  const lines: string[] = [
    `**Retrieved evidence** (ranks 1-${VERIFIER_SHORTLIST_SIZE} were shown to the verifier)`,
    '',
  ];
  context.hits.forEach((hit, index) => {
    const filename = context.filenameByDocVersionId[hit.docVersionId] ?? 'unknown file';
    const shown = index < VERIFIER_SHORTLIST_SIZE ? 'shown to verifier' : 'not shown to verifier';
    lines.push(
      `${index + 1}. \`${filename}\` — ${formatLocator(hit.locator)} — chunk \`${hit.chunkId}\` (${shown})`,
      '',
      SOURCE_FENCE,
      hit.text,
      SOURCE_FENCE,
      '',
    );
  });
  return lines;
}

function buildCitationSection(outcome: ClaimOutcome, context: ClaimContext | undefined): string[] {
  const citations = outcome.citations ?? [];
  if (citations.length === 0) {
    return ['**Citations the gate accepted:** none', ''];
  }
  const lines = ['**Citations the gate accepted**', ''];
  for (const citation of citations) {
    const filename = context?.filenameByDocVersionId[citation.docVersionId] ?? 'unknown file';
    lines.push(
      `- \`${filename}\` — ${formatLocator(citation.locator)} — chunk \`${citation.chunkId}\``,
      `  > ${citation.quote}`,
    );
  }
  lines.push('');
  return lines;
}

function buildClaimSection(outcome: ClaimOutcome, context: ClaimContext | undefined): string {
  return [
    `### claim ${outcome.claimId}`,
    '',
    `- **Verdict:** ${outcome.verdict}`,
    `- **Reason code:** ${outcome.reasonCode ?? 'none'}`,
    `- **Drafted from:** ${outcome.sourceFilename}`,
    '',
    '**Claim**',
    '',
    SOURCE_FENCE,
    outcome.statement,
    SOURCE_FENCE,
    '',
    ...buildCitationSection(outcome, context),
    ...buildEvidenceSection(context),
    '- **Adjudication:** ',
    '- **Note:** ',
    '',
  ].join('\n');
}

/**
 * Renders the hand-filled adjudication worksheet: one section per sampled gate failure, carrying
 * the claim, the gate's verdict and reason, the citations it accepted (if any), and the retrieval
 * hits behind it, with an empty adjudication field for a person to complete.
 */
export function buildWorksheet(input: WorksheetInput): string {
  const contextByClaimId = new Map(input.contexts.map((context) => [context.claimId, context]));
  const sections = input.sampled.map((outcome) =>
    buildClaimSection(outcome, contextByClaimId.get(outcome.claimId)),
  );
  return [buildHeader(input), ...sections].join('\n');
}
