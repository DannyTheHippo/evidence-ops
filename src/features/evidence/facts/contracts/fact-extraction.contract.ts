import { z } from 'zod/v4';

// `zod/v4` specifically, matching `model-provider.interface.ts` — the schema here is passed
// straight through to `ModelProvider.generate`'s `outputSchema`, which is typed against `zod/v4`'s
// `z.ZodType`; a `zod`-default (currently also v4, but not guaranteed to stay so) instance is not
// guaranteed type-identical. See `answer.contract.ts`'s header comment for the general exception
// this project makes to "zod is env-only" for the model-provider layer.

/**
 * One fact the model proposes from a chunk of document text. Everything here is untrusted until
 * the application verifies it: `metric` is the only field zod itself constrains to the allowlist
 * `metricIds` passes in — `unit`, `quote` and `entityQuote` are verified against the ontology and
 * the source chunk by `prose-fact-extractor.ts` after the call returns — a schema can shape the
 * JSON, but only application code can check a quote is real.
 *
 * Built from `metricIds` rather than hardcoding `METRIC_IDS` directly so `prose-fact-extractor.ts`
 * can call this once per extraction with `METRIC_ONTOLOGY`'s metric ids, in the ontology's own
 * order, without this file importing `metric-ontology.ts` itself.
 */
export function buildFactCandidateSchema(metricIds: readonly string[]) {
  return z.object({
    /** The span of the chunk that names the entity this fact is about, copied verbatim — an
     * extractive field, not free text: two passes over one sentence that both copy from the source
     * return the same characters, where two passes each writing the entity's name in their own
     * words do not, and a difference there splits one entity into two `(entity, metric, period)`
     * groups that then never agree. Verified as a real span of the chunk by
     * `prose-fact-extractor.ts`, on the same `locateQuote` containment `quote` is verified with, and
     * resolved against the tenant's `CanonicalEntity` registry before agreement runs. Capped at 200
     * characters — an entity name is a phrase, not the sentence `quote` carries. */
    entityQuote: z.string().min(1).max(200),
    metric: z.enum(metricIds),
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
}

export type FactCandidateOutput = z.infer<ReturnType<typeof buildFactCandidateSchema>>;

export function buildFactExtractionResultSchema(metricIds: readonly string[]) {
  return z.object({
    facts: z.array(buildFactCandidateSchema(metricIds)),
  });
}
