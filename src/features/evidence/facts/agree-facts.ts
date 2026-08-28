import type { FactKey } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { groupKey } from '../conflicts/detect-conflicts';
import { isConflictingPair, normalizeFactValue } from '../conflicts/normalize-fact-value';
import { findMetricById, type MetricDefinition } from './metric-ontology';
import type { ExtractedFactInput } from './prose-fact-extractor';

const MIN_AGREEING_PASSES = 2;

/** A `(entity, metric, period)` group whose candidates never reached `MIN_AGREEING_PASSES` —
 * kept visible (mirrors `SkippedFact` in `detect-conflicts.ts`) rather than vanishing into an
 * empty `facts` array indistinguishable from "nothing was there". */
export interface DroppedFactGroup {
  readonly factKey: FactKey;
  readonly agreeingPasses: number;
  readonly totalPasses: number;
}

/** A candidate whose unit `normalizeFactValue` could not convert, or whose canonical value
 * cannot be safely compared — non-finite, or beyond `Number.MAX_SAFE_INTEGER` where a double's
 * 53-bit mantissa can no longer distinguish it from its neighbors. Should not happen — every
 * candidate reaching this module already passed `prose-fact-extractor.ts`'s own metric/unit
 * check — but kept here rather than trusted blindly, per that function's fail-open direction:
 * a broken normalization drops the one candidate it cannot compare, never the whole scan, and
 * never silently. */
export interface UnnormalizableCandidate {
  readonly fact: ExtractedFactInput;
  readonly reason: string;
}

export interface AgreementReport {
  readonly totalGroups: number;
  readonly survivingFacts: number;
  readonly droppedGroups: readonly DroppedFactGroup[];
  readonly unnormalizable: readonly UnnormalizableCandidate[];
}

export interface AgreeFactsResult<T extends ExtractedFactInput> {
  readonly facts: T[];
  readonly report: AgreementReport;
}

interface Vote<T extends ExtractedFactInput> {
  readonly passIndex: number;
  readonly fact: T;
  readonly canonical: number;
}

/** The largest set of votes, drawn from distinct passes, whose canonical values all fall within
 * tolerance of some common pivot vote in the set. Trying every vote as a pivot (rather than a
 * single min/max spread, which is what `detectConflicts` uses to *flag* a disagreement) is what
 * lets a 2-of-3 majority survive even when the third pass's value is far enough off that the
 * whole group's min/max spread alone would exceed tolerance. Ties resolve to whichever pivot
 * comes first in `votes`, keeping the result deterministic. */
function largestAgreeingCluster<T extends ExtractedFactInput>(
  votes: readonly Vote<T>[],
  metric: MetricDefinition,
): Vote<T>[] {
  let best: Vote<T>[] = [];
  for (const pivot of votes) {
    const seenPasses = new Set<number>();
    const cluster: Vote<T>[] = [];
    for (const vote of votes) {
      if (seenPasses.has(vote.passIndex)) {
        continue;
      }
      if (!isConflictingPair(metric, pivot.canonical, vote.canonical)) {
        seenPasses.add(vote.passIndex);
        cluster.push(vote);
      }
    }
    if (cluster.length > best.length) {
      best = cluster;
    }
  }
  return best;
}

/**
 * Pure 2-of-N majority agreement over independent extraction passes of the same chunk. Each
 * element of `passResults` is one pass's already-grounded, already-ontology-validated candidates
 * (`prose-fact-extractor.ts`'s per-candidate checks run before this) — this module only decides
 * which `(entity, metric, period)` groups enough passes agreed on; it never re-checks grounding.
 *
 * `passResults`'s outer index is a synthetic per-successful-pass id, not the request-level
 * `ModelRequest.passOrdinal` — a pass that threw is simply absent from this array (a non-vote,
 * not a zero-vote), so index 0 here may correspond to the caller's pass 1 or 2. Only distinctness
 * across entries matters for the majority count, not which request originally produced them.
 *
 * A surviving group keeps the earliest-indexed agreeing vote's quote, locator, and value —
 * "the majority" is treated as one representative report, not an average of N reports — except
 * confidence, which is the mean of every agreeing vote's confidence.
 *
 * Generic in the candidate type so a caller that has already attached its own per-candidate fields
 * — `prose-fact-extractor.ts` attaches the registry resolution's `entityMatched` before agreement
 * runs, since agreement groups on the resolved entity name — gets those fields back on the
 * surviving representative instead of a widened `ExtractedFactInput`.
 */
export function agreeFacts<T extends ExtractedFactInput>(
  passResults: readonly (readonly T[])[],
  ontology: readonly MetricDefinition[],
): AgreeFactsResult<T> {
  const groups = new Map<string, Vote<T>[]>();
  const unnormalizable: UnnormalizableCandidate[] = [];

  passResults.forEach((passFacts, passIndex) => {
    for (const fact of passFacts) {
      const metric = findMetricById(ontology, fact.factKey.metric);
      if (!metric) {
        // Unreachable while `prose-fact-extractor.ts` and the ontology agree — mirrors
        // `detect-conflicts.ts`'s identical "should not happen" guard for the same drift case.
        unnormalizable.push({
          fact,
          reason: `metric '${fact.factKey.metric}' is not in the ontology`,
        });
        continue;
      }

      const canonical = normalizeFactValue(metric, fact.value);
      if (canonical === undefined) {
        unnormalizable.push({
          fact,
          reason: `unit '${fact.value.unit}' is not valid for metric '${metric.id}'`,
        });
        continue;
      }

      // Fails toward unnormalizable, never toward agreement: `isConflictingPair`'s `>`
      // comparisons are all `false` against a non-finite operand, and a value at or beyond
      // `Number.MAX_SAFE_INTEGER` can collide with an unrelated value once both round to the
      // same double — either way a poisoned candidate would look indistinguishable from every
      // other vote in `largestAgreeingCluster`, survive `MIN_AGREEING_PASSES`, and — via the
      // earliest-`passIndex` tiebreak below — become the persisted representative fact.
      if (!Number.isFinite(canonical) || Math.abs(canonical) > Number.MAX_SAFE_INTEGER) {
        unnormalizable.push({
          fact,
          reason: `value '${fact.value.amount} ${fact.value.unit}' does not convert to a safely comparable ${metric.canonicalUnit} value for metric '${metric.id}'`,
        });
        continue;
      }

      const key = groupKey(fact.factKey);
      const votes = groups.get(key) ?? [];
      votes.push({ passIndex, fact, canonical });
      groups.set(key, votes);
    }
  });

  const facts: T[] = [];
  const droppedGroups: DroppedFactGroup[] = [];

  for (const votes of groups.values()) {
    const metric = findMetricById(ontology, votes[0].fact.factKey.metric);
    if (!metric) {
      // Unreachable: every vote already passed the ontology check above.
      continue;
    }

    const cluster = largestAgreeingCluster(votes, metric);
    const agreeingPasses = new Set(cluster.map((vote) => vote.passIndex)).size;
    const totalPasses = new Set(votes.map((vote) => vote.passIndex)).size;

    if (agreeingPasses < MIN_AGREEING_PASSES) {
      droppedGroups.push({ factKey: votes[0].fact.factKey, agreeingPasses, totalPasses });
      continue;
    }

    const representative = cluster.reduce((earliest, vote) =>
      vote.passIndex < earliest.passIndex ? vote : earliest,
    );
    const meanConfidence =
      cluster.reduce((sum, vote) => sum + vote.fact.confidence, 0) / cluster.length;

    facts.push({ ...representative.fact, confidence: meanConfidence });
  }

  return {
    facts,
    report: {
      totalGroups: groups.size,
      survivingFacts: facts.length,
      droppedGroups,
      unnormalizable,
    },
  };
}
