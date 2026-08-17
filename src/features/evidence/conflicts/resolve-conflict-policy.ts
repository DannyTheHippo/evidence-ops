import type { DocumentSourceClass } from '../../../database/schemas/evidence/document/document.schema';

/** A conflicting fact reduced to exactly what the survivorship policy weighs: which document
 * class it came from and, if ever recorded, when the value was observed. */
export interface ConflictingFactForResolution {
  readonly id: string;
  readonly sourceClass: DocumentSourceClass;
  readonly observedAt?: Date;
}

/**
 * Per-metric survivorship configuration. `authorityOrder` ranks `DocumentSourceClass`es from
 * most to least authoritative for this metric — absent or empty means the policy has no opinion
 * for this metric and every candidate resolves to `'none'`. `stalenessWindowMs` is the minimum
 * gap, in milliseconds, between two authority-tied facts' `observedAt` timestamps for the newer
 * one to count as meaningfully fresher; a gap at or under the window does not break the tie.
 */
export interface SurvivorshipPolicy {
  readonly authorityOrder?: readonly DocumentSourceClass[];
  readonly stalenessWindowMs: number;
}

export type ResolveConflictProposal =
  | {
      readonly ruleFired: 'authority';
      readonly proposedWinnerFactId: string;
      readonly explanation: string;
    }
  | {
      readonly ruleFired: 'recency';
      readonly proposedWinnerFactId: string;
      readonly explanation: string;
    }
  | { readonly ruleFired: 'none'; readonly explanation: string };

function none(explanation: string): ResolveConflictProposal {
  return { ruleFired: 'none', explanation };
}

/**
 * Proposes which of a set of conflicting facts a human should treat as authoritative. Pure: no
 * Mongoose, no service calls, no clock reads — every input the policy needs, including "now" via
 * each fact's own `observedAt`, arrives as an argument.
 *
 * Failure direction: fails CLOSED to `ruleFired: 'none'` (no `proposedWinnerFactId`) whenever the
 * policy is silent or contradictory, rather than guessing a winner. A wrong proposal is worse than
 * no proposal, because it is shown to a human deciding which value to trust — this function only
 * ever proposes, never resolves anything on its own. `'none'` fires when:
 * - fewer than two candidates were supplied (nothing to propose a winner over);
 * - no `authorityOrder` is configured for the metric;
 * - `authorityOrder` is internally contradictory (the same source class listed at two ranks);
 * - a candidate's `sourceClass` is `'unclassified'` — that means no authority information was
 *   ever recorded for its document, not the lowest rank, so ranking it (anywhere, even last)
 *   would invent an ordering the data does not support;
 * - a candidate's `sourceClass` is not present in the configured `authorityOrder` at all;
 * - two or more candidates tie at the top authority rank and recency cannot break the tie —
 *   because a tied candidate has no `observedAt` (an absent observation date is never treated as
 *   old or substituted with anything else), because the gap between the tied facts' `observedAt`
 *   values is not a finite number (an invalid date), because the metric has no configured
 *   `stalenessWindowMs`, or because the closest gap between them does not exceed a configured one.
 */
export function resolveConflictPolicy(
  facts: readonly ConflictingFactForResolution[],
  policy: SurvivorshipPolicy,
): ResolveConflictProposal {
  if (facts.length < 2) {
    return none(
      'Fewer than two candidates were supplied; there is nothing to propose a winner over.',
    );
  }

  const authorityOrder = policy.authorityOrder ?? [];
  if (authorityOrder.length === 0) {
    return none('No authorityOrder is configured for this metric.');
  }

  const rankByClass = new Map<DocumentSourceClass, number>();
  for (const [index, sourceClass] of authorityOrder.entries()) {
    const existingRank = rankByClass.get(sourceClass);
    if (existingRank !== undefined) {
      return none(
        `authorityOrder is contradictory: '${sourceClass}' appears at both rank ${existingRank} and rank ${index}.`,
      );
    }
    rankByClass.set(sourceClass, index);
  }

  const ranks: number[] = [];
  for (const fact of facts) {
    if (fact.sourceClass === 'unclassified') {
      return none(
        `Fact ${fact.id}'s document is unclassified — that means no authority information, not the lowest rank, so no proposal can be made.`,
      );
    }
    const rank = rankByClass.get(fact.sourceClass);
    if (rank === undefined) {
      return none(
        `Fact ${fact.id}'s source class '${fact.sourceClass}' is not present in the configured authorityOrder.`,
      );
    }
    ranks.push(rank);
  }

  const minRank = Math.min(...ranks);
  const topFacts = facts.filter((_, index) => ranks[index] === minRank);

  if (topFacts.length === 1) {
    const winner = topFacts[0];
    const outranked = facts.filter((fact) => fact.id !== winner.id).map((fact) => fact.sourceClass);
    return {
      ruleFired: 'authority',
      proposedWinnerFactId: winner.id,
      explanation: `Fact ${winner.id}'s source class '${winner.sourceClass}' outranks ${outranked.join(', ')} in the configured authorityOrder.`,
    };
  }

  const tiedIds = topFacts.map((fact) => fact.id).join(', ');
  const tiedClass = topFacts[0].sourceClass;

  if (topFacts.some((fact) => fact.observedAt === undefined)) {
    return none(
      `Facts ${tiedIds} tie on source authority ('${tiedClass}') and at least one has no observedAt, so recency cannot break the tie.`,
    );
  }

  const byRecency = [...topFacts].sort(
    (a, b) => (b.observedAt as Date).getTime() - (a.observedAt as Date).getTime(),
  );
  const [freshest, nextFreshest] = byRecency;
  const gapMs =
    (freshest.observedAt as Date).getTime() - (nextFreshest.observedAt as Date).getTime();

  if (!Number.isFinite(gapMs)) {
    return none(
      `Facts ${tiedIds} tie on source authority ('${tiedClass}'); at least one of the tied facts' observedAt is invalid, so recency cannot break the tie.`,
    );
  }

  if (!Number.isFinite(policy.stalenessWindowMs)) {
    return none(
      `Facts ${tiedIds} tie on source authority ('${tiedClass}'); this metric has no staleness window, so recency never breaks its ties.`,
    );
  }

  if (gapMs <= policy.stalenessWindowMs) {
    return none(
      `Facts ${tiedIds} tie on source authority ('${tiedClass}'); the freshest (${freshest.id}) is only ${gapMs}ms ahead of the next (${nextFreshest.id}), at or under the configured staleness window of ${policy.stalenessWindowMs}ms.`,
    );
  }

  return {
    ruleFired: 'recency',
    proposedWinnerFactId: freshest.id,
    explanation: `Facts ${tiedIds} tie on source authority ('${tiedClass}'); fact ${freshest.id} wins on recency, observed ${gapMs}ms ahead of the next-freshest (${nextFreshest.id}), past the configured staleness window of ${policy.stalenessWindowMs}ms.`,
  };
}
