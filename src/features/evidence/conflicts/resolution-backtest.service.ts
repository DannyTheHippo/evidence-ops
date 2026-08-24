import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Conflict,
  ConflictDocument,
  type ConflictResolutionOutcome,
  type ConflictRuleFired,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  DocumentDocument,
  type DocumentSourceClass,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
  type FactKey,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { MetricPoliciesService } from '../facts/metric-policies.service';
import { loadSourceClassByFactId } from './load-source-class-by-fact-id';
import {
  resolveConflictPolicy,
  type ConflictingFactForResolution,
  type SurvivorshipPolicy,
} from './resolve-conflict-policy';

export type BacktestVerdict = 'agreed' | 'disagreed' | 'silent' | 'unscorable';

/** One conflict's replay outcome. `recordedWinningFactId` is the human decision the replayed
 *  rule is scored against; `replayedRuleFired`/`replayedWinningFactId` are absent on `unscorable`
 *  (the policy was never called — see `ResolutionBacktestService.run`'s own doc comment) and
 *  `replayedWinningFactId` is additionally absent on `silent` (the policy fired no opinion). */
export interface ConflictBacktestResult {
  readonly conflictId: string;
  readonly factKey: FactKey;
  readonly verdict: BacktestVerdict;
  readonly recordedOutcome: ConflictResolutionOutcome;
  readonly recordedWinningFactId?: string;
  readonly replayedRuleFired?: ConflictRuleFired;
  readonly replayedWinningFactId?: string;
  readonly unscorableReason?: string;
}

export interface ResolutionBacktestReport {
  readonly results: readonly ConflictBacktestResult[];
  readonly agreed: number;
  readonly disagreed: number;
  readonly silent: number;
  readonly unscorable: number;
  /** `agreed / (agreed + disagreed)` — `silent` and `unscorable` results are excluded from both
   *  sides of the ratio, since neither is a rule making (and matching or missing) a call. `null`,
   *  never `0`, when nothing was scorable: `0` would assert the rule always disagreed, a
   *  different and false claim from "nothing here could be judged." */
  readonly agreementRate: number | null;
}

/**
 * Replays the tenant's CURRENT survivorship rules over every conflict that has ever had a human
 * resolution attempt, and reports where the replayed rule agrees, disagrees, has no opinion, or
 * cannot be judged at all against what the human actually decided — the hindsight check that
 * tells an operator whether their authored rules are worth trusting.
 */
@Injectable()
export class ResolutionBacktestService {
  constructor(
    @InjectModel(Conflict.name)
    private readonly conflictModel: Model<ConflictDocument>,

    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    private readonly metricPoliciesService: MetricPoliciesService,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(ResolutionBacktestService.name);
  }

  /**
   * Population: every conflict with a `resolved`, `rejected` or `timed_out` resolution attempt —
   * the three outcomes `resolveConflict`'s human-decision path can reach (`recordResolution`'s own
   * doc comment). `superseded` is excluded, not scored `unscorable`: it is
   * `DocumentsService.remove`'s own machine-driven bookkeeping when a deletion cascade leaves a
   * conflict with too few facts to stay open — no human ever decided a winner there, so there is
   * nothing this backtest exists to score.
   *
   * `scoreConflict`'s `unscorable` gates all run BEFORE `resolveConflictPolicy` is ever called for
   * a conflict — a starved candidate set (no recorded winner, or a fact deleted since resolution),
   * or a metric the tenant's currently active pack no longer defines, would each make the policy
   * return `ruleFired: 'none'`, indistinguishable from a genuine `silent` unless the relevant gate
   * is checked first and the policy call is skipped entirely.
   */
  async run(tenantId: string): Promise<ResolutionBacktestReport> {
    const conflicts = await this.conflictModel.find({
      tenantId,
      'resolution.outcome': { $in: ['resolved', 'rejected', 'timed_out'] },
    });

    if (conflicts.length === 0) {
      this.logger.debug(`No resolved conflicts to backtest for tenant '${tenantId}'`);
      return {
        results: [],
        agreed: 0,
        disagreed: 0,
        silent: 0,
        unscorable: 0,
        agreementRate: null,
      };
    }

    // Resolved once for the whole run, not once per conflict — same reasoning `ConflictsService
    // .list` documents for its own identical call.
    const policies = await this.metricPoliciesService.resolveForTenant(tenantId);

    const everyFactId = [
      ...new Set(conflicts.flatMap((conflict) => conflict.factIds.map((id) => id.toString()))),
    ].map((id) => new Types.ObjectId(id));
    const facts = await this.extractedFactModel.find({ _id: { $in: everyFactId }, tenantId });
    const factById = new Map(facts.map((fact) => [fact._id.toString(), fact]));
    const sourceClassByFactId = await loadSourceClassByFactId(
      this.documentVersionModel,
      this.documentModel,
      facts,
      tenantId,
    );

    const results = conflicts.map((conflict) =>
      this.scoreConflict(conflict, factById, sourceClassByFactId, policies),
    );

    const agreed = results.filter((result) => result.verdict === 'agreed').length;
    const disagreed = results.filter((result) => result.verdict === 'disagreed').length;
    const silent = results.filter((result) => result.verdict === 'silent').length;
    const unscorable = results.filter((result) => result.verdict === 'unscorable').length;
    const scorable = agreed + disagreed;

    this.logger.debug(
      `Backtested ${results.length} resolved conflict(s) for tenant '${tenantId}': ` +
        `${agreed} agreed, ${disagreed} disagreed, ${silent} silent, ${unscorable} unscorable`,
    );

    return {
      results,
      agreed,
      disagreed,
      silent,
      unscorable,
      agreementRate: scorable > 0 ? agreed / scorable : null,
    };
  }

  /**
   * Pure given its inputs: `factById` and `sourceClassByFactId` are the whole run's batched
   * enrichment (see `run`), never re-queried per conflict. All three `unscorable` gates below
   * `return` before `resolveConflictPolicy` is reached — that early return, not merely the label
   * on the result, is what proves this conflict's replay never happened.
   */
  private scoreConflict(
    conflict: ConflictDocument,
    factById: ReadonlyMap<string, ExtractedFactDocument>,
    sourceClassByFactId: ReadonlyMap<string, DocumentSourceClass>,
    policies: ReadonlyMap<string, SurvivorshipPolicy>,
  ): ConflictBacktestResult {
    // `conflict.resolution` is guaranteed present — `run`'s query only ever returns conflicts
    // matching `'resolution.outcome': { $in: [...] }` — but the field stays optional on the
    // schema, so the cast documents that guarantee rather than silencing a real absence.
    const resolution = conflict.resolution as NonNullable<ConflictDocument['resolution']>;
    const base = {
      conflictId: conflict._id.toString(),
      factKey: {
        entity: conflict.factKey.entity,
        metric: conflict.factKey.metric,
        period: conflict.factKey.period,
      },
      recordedOutcome: resolution.outcome,
      recordedWinningFactId: resolution.winningFactId?.toString(),
    };

    // Gate ONE, before any policy call: a `rejected`/`timed_out` attempt (or a pre-capture
    // history record) named no winner, so there is nothing recorded to compare a replayed
    // proposal against. This is what separates `unscorable` ("we cannot tell you anything about
    // this one") from `silent` ("your rule has no opinion here, consider adding one").
    if (base.recordedWinningFactId === undefined) {
      return {
        ...base,
        verdict: 'unscorable',
        unscorableReason: `Outcome '${base.recordedOutcome}' recorded no winning fact to score against.`,
      };
    }

    // Gate TWO, before any policy call: every one of this conflict's `factIds` must still resolve
    // to an `ExtractedFact`. Reachable, not hypothetical: `DocumentsService.remove` keeps every
    // conflict's `factIds` in sync with the facts it deletes, but that guarantee only covers facts
    // deleted through that one path — a row written directly against the collection, or one that
    // predates the guarantee, can still carry a `factIds` entry with nothing behind it. A starved
    // candidate set would make `resolveConflictPolicy` return `'none'`, indistinguishable from a
    // genuine `silent` — the gate keeps the two apart by never making the call at all.
    const conflictFacts: ExtractedFactDocument[] = [];
    for (const id of conflict.factIds) {
      const fact = factById.get(id.toString());
      if (fact) {
        conflictFacts.push(fact);
      }
    }
    if (conflictFacts.length < conflict.factIds.length) {
      return {
        ...base,
        verdict: 'unscorable',
        unscorableReason:
          `${conflict.factIds.length - conflictFacts.length} of ${conflict.factIds.length} ` +
          'disagreeing fact(s) no longer resolve to an ExtractedFact.',
      };
    }

    // Gate THREE, before any policy call: `conflict.factKey.metric` must be a metric the tenant's
    // currently resolved active pack still defines. A dropped metric has no policy row to look up
    // at all — `resolveConflictPolicy` would return `ruleFired: 'none'`, indistinguishable from a
    // genuine `silent` (which means "your rule has no opinion, consider authoring one"), but there
    // is no rule to author for a metric the pack no longer contains. The gate keeps the two apart
    // by never making the call.
    if (!policies.has(conflict.factKey.metric)) {
      return {
        ...base,
        verdict: 'unscorable',
        unscorableReason: `Metric '${conflict.factKey.metric}' is not defined by the tenant's active metric pack.`,
      };
    }

    const candidates: ConflictingFactForResolution[] = conflictFacts.map((fact) => ({
      id: fact._id.toString(),
      // Both gates above passed, so every fact here was in `factById` — `loadSourceClassByFactId`
      // sets an entry for every fact it was given (own doc comment), so this lookup can never
      // miss; `as` (not `??`) keeps TypeScript satisfied without an untestable fallback branch.
      sourceClass: sourceClassByFactId.get(fact._id.toString()) as DocumentSourceClass,
      observedAt: fact.observedAt,
    }));
    // Gate THREE above guarantees `policies.has(conflict.factKey.metric)`; `as` (not `??`) keeps
    // TypeScript satisfied without an untestable fallback branch, matching `sourceClass`'s
    // identical pattern above.
    const policy = policies.get(conflict.factKey.metric) as SurvivorshipPolicy;
    const proposal = resolveConflictPolicy(candidates, policy);

    if (proposal.ruleFired === 'none') {
      return { ...base, verdict: 'silent', replayedRuleFired: 'none' };
    }

    const agrees = proposal.proposedWinnerFactId === base.recordedWinningFactId;
    return {
      ...base,
      verdict: agrees ? 'agreed' : 'disagreed',
      replayedRuleFired: proposal.ruleFired,
      replayedWinningFactId: proposal.proposedWinnerFactId,
    };
  }
}
