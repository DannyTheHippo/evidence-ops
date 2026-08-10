import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type {
  ExtractionMethod,
  FactKey,
  FactValue,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { ModelProvider } from '../../../providers/model/model-provider.interface';
import type { ParsedElement } from '../ingestion/parsers/parsed-element.type';
import {
  factExtractionResultSchema,
  type FactCandidateOutput,
} from './contracts/fact-extraction.contract';
import { derivePeriodFromDateText } from './derive-period';
import { findMetricById, type MetricDefinition } from './metric-ontology';

export interface ExtractedFactInput {
  readonly factKey: FactKey;
  readonly value: FactValue;
  readonly rawText: string;
  readonly confidence: number;
  readonly extractionMethod: ExtractionMethod;
  readonly locator: EvidenceLocator;
}

export interface RejectedFactCandidate {
  readonly candidate: FactCandidateOutput;
  readonly reason: string;
}

export interface ProseFactExtractionResult {
  readonly accepted: ExtractedFactInput[];
  readonly rejected: RejectedFactCandidate[];
}

const MAX_OUTPUT_TOKENS = 2048;
// Structured extraction over one already-chunked window of text; a runaway estimate here would
// indicate a pricing-table or prompt-construction bug, not a normal call, so the cap is generous
// rather than tuned tight.
const MAX_COST_USD = 1;

function buildSystemPrompt(ontology: readonly MetricDefinition[]): string {
  const metricLines = ontology
    .map(
      (metric) =>
        `- ${metric.id}: ${metric.label} (aliases: ${metric.aliases.join(', ')}; units: ${metric.units
          .map((unit) => unit.id)
          .join(', ')})`,
    )
    .join('\n');

  return [
    'You extract structured valuation facts from a chunk of a real-estate document.',
    'Only extract facts for the following allowlisted metrics — never invent a metric id:',
    metricLines,
    'For each fact, quote the exact sentence or phrase the value comes from, verbatim and unmodified from the source text.',
    "State periodText as the literal date/time phrase the source states for this fact (e.g. 'March 2025', '2025-03-14'), or an empty string if the source states no period for it.",
  ].join('\n');
}

/**
 * A chunk can merge several pages/paragraphs (see chunker.ts's token-budget windowing), so the
 * chunk's own anchor locator may point at the wrong page for a fact that actually came from a
 * later page merged into the same chunk. This recovers the precise source: whichever original
 * parsed element's own text contains the quote. Falls back to the chunk's own locator when the
 * quote matches zero elements (quote spans a merge boundary — should not happen for a
 * single-sentence quote, since the chunker never splits mid-element) or more than one (the same
 * phrase happens to repeat verbatim elsewhere in the document) — in both cases a specific-but-wrong
 * locator is worse than an honest, broader one.
 */
function resolveFactLocator(
  quote: string,
  sourceElements: readonly ParsedElement[],
  fallback: EvidenceLocator,
): EvidenceLocator {
  const matches = sourceElements.filter((element) => element.text.includes(quote));
  return matches.length === 1 ? matches[0].locator : fallback;
}

/**
 * Extracts facts from one already-ingested chunk of PDF/DOCX text via `ModelProvider`. The model
 * proposes; this function disposes: a candidate is only accepted if (a) its metric and unit are
 * both valid per the ontology and (b) its quote is a literal substring of the chunk — verified
 * here, not trusted from the model's own claim, because a hallucinated or paraphrased quote would
 * let an ungrounded claim pass as cited evidence.
 */
export async function extractProseFacts(params: {
  readonly chunkText: string;
  readonly chunkLocator: EvidenceLocator;
  readonly sourceElements: readonly ParsedElement[];
  readonly modelProvider: ModelProvider;
  readonly ontology: readonly MetricDefinition[];
}): Promise<ProseFactExtractionResult> {
  const { chunkText, chunkLocator, sourceElements, modelProvider, ontology } = params;

  const result = await modelProvider.generate({
    taskClass: 'fact_extraction',
    system: buildSystemPrompt(ontology),
    messages: [{ role: 'user', content: chunkText }],
    outputSchema: factExtractionResultSchema,
    maxTokens: MAX_OUTPUT_TOKENS,
    maxCostUsd: MAX_COST_USD,
  });

  const accepted: ExtractedFactInput[] = [];
  const rejected: RejectedFactCandidate[] = [];

  for (const candidate of result.output.facts) {
    if (!chunkText.includes(candidate.quote)) {
      rejected.push({ candidate, reason: 'quote not found verbatim in source chunk' });
      continue;
    }

    const metric = findMetricById(ontology, candidate.metric);
    if (!metric) {
      // Unreachable while the schema and the ontology agree — `candidate.metric` is constrained
      // by `z.enum(METRIC_IDS)`. Kept as an explicit fail-closed check rather than a non-null
      // assertion in case a long-lived process ever serves a stale compiled schema against an
      // updated ontology.
      rejected.push({ candidate, reason: `metric '${candidate.metric}' is not in the ontology` });
      continue;
    }

    const unit = metric.units.find((candidateUnit) => candidateUnit.id === candidate.unit);
    if (!unit) {
      rejected.push({
        candidate,
        reason: `unit '${candidate.unit}' is not valid for metric '${metric.id}'`,
      });
      continue;
    }

    accepted.push({
      factKey: {
        entity: candidate.entity.trim(),
        metric: metric.id,
        period: derivePeriodFromDateText(candidate.periodText),
      },
      value: { amount: candidate.amount, unit: candidate.unit },
      rawText: candidate.quote,
      confidence: candidate.confidence,
      extractionMethod: 'llm',
      locator: resolveFactLocator(candidate.quote, sourceElements, chunkLocator),
    });
  }

  return { accepted, rejected };
}
