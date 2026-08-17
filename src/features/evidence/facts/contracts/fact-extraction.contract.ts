import { z } from 'zod/v4';
import { METRIC_IDS } from '../metric-ontology';

// `zod/v4` specifically, matching `model-provider.interface.ts` — the schema here is passed
// straight through to `ModelProvider.generate`'s `outputSchema`, which is typed against `zod/v4`'s
// `z.ZodType`; a `zod`-default (currently also v4, but not guaranteed to stay so) instance is not
// guaranteed type-identical. See `answer.contract.ts`'s header comment for the general exception
// this project makes to "zod is env-only" for the model-provider layer.

/**
 * One fact the model proposes from a chunk of document text. Everything here is untrusted until
 * the application verifies it: `metric` is the only field zod itself constrains to the ontology
 * (via `z.enum(METRIC_IDS)`); `unit` and `quote` are verified against the ontology and the source
 * chunk respectively by `prose-fact-extractor.ts` after the call returns — a schema can shape the
 * JSON, but only application code can check a quote is real.
 */
export const factCandidateSchema = z.object({
  entity: z.string().min(1),
  metric: z.enum(METRIC_IDS),
  /** The literal date/time phrase the source states for this fact (e.g. "March 2025",
   * "2025-03-14"), or an empty string when the source states no period at all. Left as raw text,
   * not a pre-formatted period, because coarsening it to the shared `entity/metric/period`
   * granularity is `derivePeriodFromDateText`'s job (`derive-period.ts`) — the one place that
   * logic lives, rather than trusting the model to reproduce it. */
  periodText: z.string(),
  /** An ISO `YYYY-MM-DD` date the source text explicitly states as when this value was observed
   * or recorded, or an empty string when the source states no observation date. Never inferred,
   * guessed, or derived from surrounding context — an invented observation date is worse than
   * none, because a recency rule would then fire on evidence that never actually carried one.
   * Parsed and calendar-validated by `prose-fact-extractor.ts`, never trusted as-is: an empty or
   * malformed string, or one that names a date the calendar has no such day for, leaves the fact's
   * observation date absent rather than defaulted to anything. */
  observedAtText: z.string(),
  amount: z.number(),
  unit: z.string().min(1),
  /** Verbatim substring of the chunk the value comes from — the grounding gate rejects any
   * candidate whose quote does not literally appear in the chunk text (`prose-fact-extractor.ts`).
   * Capped at 300 characters to match `answer.contract.ts`'s citation quote limit. */
  quote: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
});

export type FactCandidateOutput = z.infer<typeof factCandidateSchema>;

export const factExtractionResultSchema = z.object({
  facts: z.array(factCandidateSchema),
});

export type FactExtractionResult = z.infer<typeof factExtractionResultSchema>;
