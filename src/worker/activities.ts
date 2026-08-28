import type { INestApplicationContext } from '@nestjs/common';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { Types } from 'mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { normalizeEntityName } from '../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { FactKey } from '../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  ConflictsService,
  type ConflictedFactGroup,
  type ConflictResolutionCandidate,
  type ConflictScanResult,
  type RecordConflictResolutionInput,
  type RecordConflictResolutionResult,
} from '../features/evidence/conflicts/conflicts.service';
import {
  CanonicalEntityService,
  type CanonicalEntityListing,
} from '../features/evidence/facts/canonical-entity.service';
import {
  findStatedPeriods,
  parsePeriodKey,
  periodsOverlap,
  type Period,
} from '../features/evidence/facts/derive-period';
import { FactsService, type FactsExtractionResult } from '../features/evidence/facts/facts.service';
import { METRIC_ONTOLOGY, type MetricId } from '../features/evidence/facts/metric-ontology';
import { extractNumericTokens } from '../features/evidence/qa/extract-numeric-tokens';
import {
  filterGroupsByEntity,
  resolveQuestionEntity,
  scopeConflictToQuestion,
} from '../features/evidence/qa/scope-conflict-to-question';
import { IngestionService } from '../features/evidence/ingestion/ingestion.service';
import { SourcesService, type RunSyncResult } from '../features/evidence/sources/sources.service';
import { ApprovalsService } from '../features/evidence/approvals/approvals.service';
import {
  AnswerPersistenceService,
  type PersistAnswerInput,
  type PersistAnswerResult,
} from '../features/evidence/qa/answer-persistence.service';
import type {
  AnswerContract,
  Claim,
  VerificationReport,
} from '../features/evidence/qa/contracts/answer.contract';
import {
  EvidenceRetrievalService,
  type RetrieveEvidenceInput,
} from '../features/evidence/qa/evidence-retrieval.service';
import {
  factKeysMatch,
  GroundingGateService,
} from '../features/evidence/qa/grounding-gate.service';
import {
  SynthesisService,
  type SynthesizeAnswerResult,
} from '../features/evidence/qa/synthesis.service';
import type { RetrievedChunk } from '../features/evidence/qa/types/retrieved-chunk.type';
import type { GroundingCellFact } from '../features/evidence/qa/verify-claim';
import {
  APPROVAL_CHANNEL,
  type ApprovalChannel,
  type ApprovalHandle,
  type ApprovalRequest,
  type ApprovalResult,
} from '../providers/approval-channel/approval-channel.interface';
import type { AlsContext } from '../shared/types/als-context.type';
import { INGEST_HEARTBEAT_INTERVAL_MS } from '../workflows/ingest-retry-policy';
import type { IngestDocumentVersionResult } from '../workflows/types';

/**
 * Widens conflict forcing to the prose side of ADR-0004 bound 3, which `GroundingGateService`
 * itself only ever computes from `cellFacts` — deliberately `xlsx-cell`-only (see
 * `FactsService.findCellFacts`'s doc comment). That narrowness is load-bearing there: `cellFacts`
 * doubles as the gate's numeric-support authority signal (bound 2), and widening it to every
 * locator kind would make any prose chunk with even one extracted fact "authoritative", rejecting
 * a claim's other numbers that structured (model-based, incomplete) prose extraction simply never
 * captured. So this check runs independently, here, over `conflictGroups` already loaded for this
 * request (never a second query) — reusing the exact value-matched, per-claim-citation discipline
 * bound 3 established: a claim forces `conflicting_evidence` only when it states a number that is
 * itself one of a known conflict's values, sourced from a chunk that claim's own citations name —
 * never merely because the claim cites a chunk that also happens to hold an unrelated conflicted
 * fact. Inherits bound 3's known remainders for the same reason the gate's own check does: a claim
 * stating a conflicted value as an ordinal, a fraction, or in a non-English numeral vocabulary is
 * invisible to `extractNumericTokens`, and
 * two distinct facts sharing the exact same `value` on the same cited chunk would still cross-touch.
 *
 * `scopedEntity`, when given, narrows `conflictGroups` to the ones belonging to it
 * (`filterGroupsByEntity`, `scope-conflict-to-question.ts`) before the cited-chunk/numeric-token
 * match above ever runs — the caller resolves it once, from the question text, via
 * `resolveQuestionEntity`. Absent, every group stays a candidate, unchanged from before entity
 * scoping existed.
 */
function findEitherSideConflict(
  claims: readonly Claim[],
  conflictGroups: readonly ConflictedFactGroup[],
  scopedEntity?: CanonicalEntityListing,
): ConflictedFactGroup | undefined {
  const candidateGroups = scopedEntity
    ? filterGroupsByEntity(conflictGroups, scopedEntity)
    : conflictGroups;
  for (const claim of claims) {
    const citedChunkIds = new Set(claim.citations.map((citation) => citation.chunkId));
    const claimedNumbers = extractNumericTokens(claim.statement);
    const match = candidateGroups.find((group) =>
      group.values.some(
        (value) => citedChunkIds.has(value.sourceChunkId) && claimedNumbers.includes(value.value),
      ),
    );
    if (match) {
      return match;
    }
  }
  return undefined;
}

/** Whole-token occurrence of `needle` in `haystack`. Both arguments must already be
 *  `normalizeEntityName`-normalized (`canonical-entity.schema.ts`) — this normalizes nothing
 *  itself, so a caller passing raw text gets a match against raw bytes. A hit counts only when
 *  neither the character before nor the character after is `[a-z0-9]`, so `'northgate'` matches
 *  `'northgate business park'` but not `'northgateway'`. */
function occursAsWholeToken(haystack: string, needle: string): boolean {
  if (!needle) {
    return false;
  }
  const isWordChar = (char: string | undefined): boolean =>
    char !== undefined && /[a-z0-9]/.test(char);

  let searchFrom = 0;
  for (;;) {
    const index = haystack.indexOf(needle, searchFrom);
    if (index === -1) {
      return false;
    }
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }
    searchFrom = index + 1;
  }
}

/**
 * The single metric `questionText` names from the fixed `METRIC_ONTOLOGY` allowlist, or
 * `undefined` when that cannot be determined safely — same fail-closed shape as
 * `resolveQuestionEntity` (`scope-conflict-to-question.ts`): naming zero metrics or naming more
 * than one distinct metric both return `undefined` rather than guessing. Matched against every
 * metric's `label` and `aliases` on whole-token boundaries, exact and alias-only, never fuzzy — a
 * fuzzy match here would force `conflicting_evidence` off a metric the question never actually
 * named.
 */
function resolveQuestionMetric(questionText: string): MetricId | undefined {
  const normalizedQuestion = normalizeEntityName(questionText);
  const namedMetrics = METRIC_ONTOLOGY.filter((metric) =>
    [metric.label, ...metric.aliases].some((phrase) =>
      occursAsWholeToken(normalizedQuestion, normalizeEntityName(phrase)),
    ),
  );
  const distinctIds = new Set(namedMetrics.map((metric) => metric.id));
  return distinctIds.size === 1 ? namedMetrics[0].id : undefined;
}

/**
 * The single period `questionText` names, or `undefined` when it names none or names more than
 * one — the same fail-closed shape as `resolveQuestionEntity` and {@link resolveQuestionMetric},
 * for the same reason: a question mentioning both `2019` and `2024` gives no basis for picking
 * either, and picking one would force `conflicting_evidence` off a period the reader did not ask
 * about. Read in sentence semantics (`findStatedPeriods`), where a bare plausible year counts as a
 * period reference.
 */
function resolveQuestionPeriod(questionText: string): Period | undefined {
  const stated = findStatedPeriods(questionText);
  return stated.length === 1 ? stated[0] : undefined;
}

/**
 * The single open `ConflictedFactGroup` `questionText` names by its resolved entity
 * (`resolveQuestionEntity`), its resolved metric ({@link resolveQuestionMetric}), and a period
 * that answers to the one the question named ({@link resolveQuestionPeriod}) — or `undefined`
 * when any of the three fails to resolve to exactly one, or more than one group answers to them.
 * Intended to run over `conflictGroups` loaded tenant-wide
 * (`ConflictsService.findConflictedFactGroupsForTenant`), never scoped to which chunks a request
 * happened to retrieve — this is the retrieval-independent force `groundingCheck` applies ahead of
 * every claim- or chunk-dependent check, so a conflicting document that never lands in a request's
 * top-k retrieval can still force `conflicting_evidence`, and a differently worded question that
 * still names the same entity, metric and period reaches the same outcome.
 *
 * Period matching has two branches, and both fail CLOSED — this force replaces an answer rather
 * than annotating one (`conflicting_evidence` returns no claims), so a period it cannot show to
 * match must never produce a match:
 *
 * - The question names a period: the group's own period, recovered from its stored key
 *   (`parsePeriodKey`), must share a calendar day with it (`periodsOverlap`). A group whose period
 *   has no calendar bounds — a fiscal year, an unstated period, a period text the extractor could
 *   not read — overlaps nothing and cannot match, and a conflict dated `2024` cannot force for a
 *   question about `2019`.
 * - The question names none: only a group whose period is itself `unstated` matches. A group whose
 *   period is unreadable is excluded here too, because its source did state a period — matching it
 *   against a question that stated none would attach a disagreement about an unknown time to a
 *   question that asked about no particular time.
 *
 * A dated conflict group the question does not name still reaches `conflicting_evidence` through
 * the claim- and chunk-scoped checks below (`findEitherSideConflict`, `scopeConflictToQuestion`),
 * which key off the claim's own cited chunk and stated value rather than a period.
 */
function resolveQuestionScopedConflictGroup(
  questionText: string,
  conflictGroups: readonly ConflictedFactGroup[],
  canonicalEntities: readonly CanonicalEntityListing[],
): ConflictedFactGroup | undefined {
  const entity = resolveQuestionEntity(questionText, canonicalEntities);
  const metricId = resolveQuestionMetric(questionText);
  if (!entity || !metricId) {
    return undefined;
  }
  const questionPeriod = resolveQuestionPeriod(questionText);
  const matches = filterGroupsByEntity(conflictGroups, entity).filter((group) => {
    if (group.factKey.metric !== metricId) {
      return false;
    }
    const groupPeriod = parsePeriodKey(group.factKey.period);
    return questionPeriod
      ? periodsOverlap(questionPeriod, groupPeriod)
      : groupPeriod.granularity === 'unstated';
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export interface LoadConflictActivityInput {
  readonly conflictId: string;
  readonly winningFactId: string;
  readonly tenantId: string;
}

export interface SynthesizeAnswerActivityInput {
  readonly questionText: string;
  readonly chunks: readonly RetrievedChunk[];
  readonly tenantId: string;
}

export interface GroundingCheckActivityInput {
  readonly outcome: AnswerContract;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly tenantId: string;
  /** The question the answer was synthesized for — optional, not required, so a workflow history
   *  replayed from before this field existed still supplies a valid input rather than failing on a
   *  field it never carried. Absent, `resolveQuestionEntity` names no entity from an empty question,
   *  so `groundingCheck` abstains (`insufficient_evidence`) rather than attaching any conflict. */
  readonly questionText?: string;
}

export interface GroundingCheckActivityResult {
  /** The gate-verified outcome, never the model's raw claim: when `GroundingGateService.verify`
   * degrades (e.g. every claim dropped → `insufficient_evidence`), this is the degraded outcome,
   * not `input.outcome`. Always present, including on the non-`answered` early-return branch
   * below, where the model's own outcome passes through unchanged because there was nothing to
   * verify. */
  readonly outcome: AnswerContract;
  readonly claims: readonly Claim[];
  readonly claimCoverage?: number;
  readonly verificationReport?: VerificationReport;
  /** The `Conflict._id`(s) that caused `outcome.kind === 'conflicting_evidence'` — absent
   * whenever `outcome` is not that kind. Threaded through to `Answer.conflictIds` by
   * `answer-question.workflow.ts` so a conflicting-evidence answer names the record(s) that
   * produced it, not just their values. */
  readonly conflictIds?: readonly string[];
}

/**
 * Activity function signatures. Workflow code imports this interface `import type` only (see
 * `src/workflows/ingest-document-version.workflow.ts`) so the type-erasure boundary is explicit:
 * a workflow file that switched to a value import of this module would pull `@nestjs/common` and
 * every service below (and, transitively, mongoose) into the workflow bundle — exactly what the
 * bundler half of the determinism fence exists to reject (ADR-0003).
 */
export interface Activities {
  ingestDocumentVersion(
    documentVersionId: string,
    tenantId: string,
  ): Promise<IngestDocumentVersionResult>;
  extractFacts(documentVersionId: string, tenantId: string): Promise<FactsExtractionResult>;
  /** Backs `ingest-document-version.workflow.ts`'s handling of an `extractFacts` failure — moves
   *  a version whose chunks are committed but whose facts are missing from `completed` to
   *  `facts-failed` (`IngestionService.recordFactExtractionFailure`), so the two are
   *  distinguishable to `DocumentsService.list` and the Data Room UI. */
  recordFactExtractionFailure(
    documentVersionId: string,
    tenantId: string,
    reason: string,
  ): Promise<void>;
  scanForConflicts(tenantId: string, factKeys?: readonly FactKey[]): Promise<ConflictScanResult>;
  retrieveEvidence(input: RetrieveEvidenceInput): Promise<RetrievedChunk[]>;
  synthesizeAnswer(input: SynthesizeAnswerActivityInput): Promise<SynthesizeAnswerResult>;
  groundingCheck(input: GroundingCheckActivityInput): Promise<GroundingCheckActivityResult>;
  persistAnswer(input: PersistAnswerInput): Promise<PersistAnswerResult>;
  loadConflict(input: LoadConflictActivityInput): Promise<ConflictResolutionCandidate>;
  requestConflictApproval(request: ApprovalRequest): Promise<ApprovalHandle>;
  // Same underlying `ApprovalChannel.requestApproval` call as `requestConflictApproval` above —
  // kept as its own named activity, not a shared generic one, matching the one-activity-per-
  // calling-workflow convention every other activity in this interface follows (`loadConflict`,
  // `recordConflictResolution`), so each workflow's `proxyActivities` group names exactly the
  // calls it makes rather than a name that says "conflict" to a caller that isn't one.
  requestIngestApproval(request: ApprovalRequest): Promise<ApprovalHandle>;
  getApprovalDecision(approvalId: string, tenantId: string): Promise<ApprovalResult>;
  /** Backs `resolveConflict`'s timeout branch (`resolve-conflict.workflow.ts`) — moves the
   *  `Approval` row itself to `timed_out` (`ApprovalsService.expire`) so it leaves the pending
   *  inbox and can never be decided afterwards, closing the gap where a human could still approve
   *  a row a dead workflow already gave up waiting on. */
  expireApproval(approvalId: string, tenantId: string): Promise<void>;
  recordConflictResolution(
    input: RecordConflictResolutionInput,
  ): Promise<RecordConflictResolutionResult>;
  /** `sourceId` only — mints a fresh `leaseToken` here, activity-side, on every call, since a
   * Temporal retry of this exact activity reuses the identical input and could never distinguish a
   * stale attempt from a newer one with a token threaded through the workflow instead (see
   * `SourcesService.runSync`'s own doc comment). Also resolves and opens the tenant's ALS scope
   * itself (`SourcesService.findTenantIdForSync`), since `sourceId` alone names no tenant. */
  runSourceSync(sourceId: string): Promise<RunSyncResult>;
}

/**
 * FAILS CLOSED: rejects a missing/empty `tenantId` rather than letting an activity run with one
 * unset. Every `Activities` signature already types `tenantId: string`, but that only binds new
 * workflow executions — Temporal replays histories started before this deploy, and a history
 * recorded before the tenant requirement existed supplies no `tenantId` at all, type or no type.
 * Non-retryable: a history that never had a tenant can never acquire one, so retrying would only
 * burn the activity's retry budget reaching the same failure.
 */
function requireTenantId(tenantId: string | undefined | null): string {
  if (!tenantId) {
    throw ApplicationFailure.nonRetryable(
      'Activity received no tenantId; a stale workflow history predates the tenant requirement ' +
        'and can never acquire one by retrying',
      'MissingTenantId',
    );
  }
  return tenantId;
}

/**
 * Restores `tenantScopePlugin`'s structural backstop (`src/database/plugins/tenant-scope.plugin.ts`)
 * for activity code. That plugin reads the tenant from AsyncLocalStorage and no-ops outside a
 * request; an activity runs with no request to inherit a store from, so without this every
 * Mongoose query `fn` awaits bypasses the backstop entirely. Running `fn` inside a fresh scope
 * carrying `tenantId` gives it back. This is defence in depth, layered on top of — never a
 * substitute for — the explicit `tenantId` predicate every tenant-scoped service call already
 * carries; nothing here removes or loosens one of those.
 *
 * `fn` must `await` its work before returning, not merely construct a query and hand it off: a
 * Mongoose query built inside this scope but awaited after it exits runs unscoped (the same
 * laziness caveat `tenantScopePlugin`'s own doc comment documents).
 *
 * `async` rather than a plain function returning `als.run(...)` directly: every activity in
 * `Activities` types as returning a `Promise`, and a caller reasonably relies on that — a plain
 * function would let `requireTenantId`'s rejection throw synchronously out of the call instead of
 * arriving as a rejected promise like every other failure this activity can produce.
 */
async function withTenantScope<T>(
  als: AsyncLocalStorage<AlsContext>,
  tenantId: string | undefined | null,
  fn: () => Promise<T>,
): Promise<T> {
  const tenant = requireTenantId(tenantId);
  return als.run({ 'correlation-id': randomUUID(), tenant }, fn);
}

/**
 * Activities are thin closures over services resolved from the worker's own Nest application
 * context (`worker.module.ts`, booted in `main.ts`) — the same DI graph the API process uses, per
 * ADR-0003's "Wiring to NestJS" section. All non-deterministic work (the Mongo reads/writes,
 * model calls, parsing, embedding) lives here, never in workflow code.
 */
export function createActivities(app: INestApplicationContext): Activities {
  const ingestionService = app.get(IngestionService);
  const factsService = app.get(FactsService);
  const conflictsService = app.get(ConflictsService);
  const canonicalEntityService = app.get(CanonicalEntityService);
  const evidenceRetrievalService = app.get(EvidenceRetrievalService);
  const synthesisService = app.get(SynthesisService);
  const groundingGateService = app.get(GroundingGateService);
  const answerPersistenceService = app.get(AnswerPersistenceService);
  const approvalChannel = app.get<ApprovalChannel>(APPROVAL_CHANNEL);
  const approvalsService = app.get(ApprovalsService);
  const sourcesService = app.get(SourcesService);
  const als = app.get<AsyncLocalStorage<AlsContext>>(AsyncLocalStorage);

  return {
    // The only activity here that heartbeats, because it is the only one that can run for minutes
    // over bytes of unknown size. `INGEST_HEARTBEAT_TIMEOUT_MS`
    // (`ingest-document-version.workflow.ts`'s `heartbeatTimeout`) is what gives these heartbeats
    // an effect: without it Temporal never fails a stalled attempt early, and — because
    // cancellation reaches a running activity on the heartbeat response — never tells this one it
    // has been abandoned. `cancellationSignal` carries that news into `ingestVersion`, whose catch
    // records the version `failed` instead of leaving it `pending` with a live lease.
    ingestDocumentVersion: (documentVersionId, tenantId) => {
      const context = Context.current();
      const heartbeats = setInterval(() => {
        context.heartbeat();
      }, INGEST_HEARTBEAT_INTERVAL_MS);

      return withTenantScope(als, tenantId, () =>
        ingestionService.ingestVersion(documentVersionId, tenantId, context.cancellationSignal),
      ).finally(() => {
        clearInterval(heartbeats);
      });
    },

    extractFacts: (documentVersionId, tenantId) =>
      withTenantScope(als, tenantId, () => factsService.extractFacts(documentVersionId, tenantId)),

    recordFactExtractionFailure: (documentVersionId, tenantId, reason) =>
      withTenantScope(als, tenantId, async () => {
        await ingestionService.recordFactExtractionFailure(documentVersionId, tenantId, reason);
      }),

    scanForConflicts: (tenantId, factKeys) =>
      withTenantScope(als, tenantId, () => conflictsService.scanForConflicts(tenantId, factKeys)),

    retrieveEvidence: (input) =>
      withTenantScope(als, input.tenantId, () => evidenceRetrievalService.retrieve(input)),

    // `SynthesisService` injects no Mongoose model of its own, but `MODEL_PROVIDER`
    // (`providers.module.ts`) wraps every provider with `TenantSpendService`, which reserves and
    // settles spend through `ModelSpendWindow` — a document that extends `AuditableDocument` and so
    // needs the same ALS scope every other tenant-carrying activity opens, or its `createdBy`/
    // `updatedBy` stamp nothing.
    synthesizeAnswer: (input) =>
      withTenantScope(als, input.tenantId, async () => {
        // Zero retrieved chunks means no claim the model could produce would cite anything real —
        // `groundingCheck` below would drop every claim and degrade `outcomeKind` to
        // `insufficient_evidence` regardless of what synthesis returns, so this reaches that same
        // outcome without spending a model call synthesis can never ground. No `reasonCode`: this
        // abstention happens before the model is ever asked, so it is the server's own, not a
        // model-authored one — same distinction `insufficientEvidenceOutcomeSchema`'s doc comment
        // draws, which is what `ProvenanceRail` (SPA) keys its degraded-state rendering on.
        if (input.chunks.length === 0) {
          return {
            contract: {
              kind: 'insufficient_evidence' as const,
              reason:
                'No evidence was retrieved for this question, so there is nothing to ground an answer in.',
            },
            usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
          };
        }
        return synthesisService.synthesizeAnswer({
          question: input.questionText,
          chunks: input.chunks,
          tenantId: input.tenantId,
        });
      }),

    // `GroundingGateService.verify`'s input type only accepts the `answered` branch of
    // `AnswerContract` (see its own doc comment) — the model itself already said there was
    // nothing to cite for `conflicting_evidence` (unreachable from a real model call — see
    // `modelAnswerContractSchema`'s doc comment — kept here only as a fail-closed pass-through for
    // a shape `AnswerContract`'s type allows), so there is nothing to verify and the model's own
    // outcome passes through unchanged.
    //
    // `insufficient_evidence` gets its own branch below: "model hints, server verifies". The model
    // can flag a self-noticed contradiction only via `reasonCode: 'retrieved_evidence_contradicts_itself'`
    // (`conflicting_evidence` was deliberately removed from the model-facing schema — ADR-0004
    // bound 4/5) — that code is a HINT, never the verdict. FAILS CLOSED: absent an independently
    // verified open conflict among the retrieved chunks' own facts, the abstention is returned
    // unchanged, regardless of what the model claimed. `reasonCode` itself is safe to branch on
    // even from an unvalidated `ModelProvider` — `SynthesisService.resolveContract` already drops
    // any value outside the three closed literals (`resolveReasonCode`) before this ever runs, so
    // a bogus/injected code just never matches this literal and falls through to "unchanged".
    groundingCheck: (input) =>
      withTenantScope(als, input.tenantId, async () => {
        // Retrieval-independent force, ahead of every kind-based branch below: loads every one of
        // the tenant's `open` conflicts (`findConflictedFactGroupsForTenant`, never scoped to
        // `input.retrievedChunks`) and, when the question's own text resolves to exactly one entity
        // and exactly one metric naming exactly one `undated` group among those, forces
        // `conflicting_evidence` immediately — regardless of what the model claimed, cited, or
        // abstained on, and even when zero chunks were retrieved at all. This is what closes the
        // gap every check below still has: each of them only ever considers a conflict "in play"
        // when a *retrieved* chunk's own fact touches it, so a conflicting document that never
        // lands in top-k can otherwise never force this outcome, and a differently worded question
        // that still names the same entity and metric could otherwise reach a different outcome
        // depending on what got retrieved. Restricted to `undated` groups because this function
        // never derives the question's own period (`resolveQuestionScopedConflictGroup`'s own doc
        // comment) — a dated group is left to the claim- and chunk-scoped checks below instead.
        const [tenantConflictGroups, canonicalEntities] = await Promise.all([
          conflictsService.findConflictedFactGroupsForTenant(input.tenantId),
          canonicalEntityService.listCanonicalEntities(input.tenantId),
        ]);
        const questionScopedGroup = resolveQuestionScopedConflictGroup(
          input.questionText ?? '',
          tenantConflictGroups,
          canonicalEntities,
        );
        if (questionScopedGroup) {
          return {
            outcome: {
              kind: 'conflicting_evidence',
              factKey: questionScopedGroup.factKey,
              // `AnswerContract`'s `values` (mutable, zod-inferred) doesn't accept
              // `ConflictedFactGroup.values`'s `readonly ConflictedFactValue[]` directly.
              values: [...questionScopedGroup.values],
            },
            claims: [],
            conflictIds: [questionScopedGroup.conflictId],
          };
        }

        if (input.outcome.kind === 'insufficient_evidence') {
          if (input.outcome.reasonCode === 'retrieved_evidence_contradicts_itself') {
            const chunkIds = input.retrievedChunks.map((chunk) => chunk.chunkId);
            const conflictGroups = await conflictsService.findConflictedFactGroupsForChunks(
              chunkIds,
              input.tenantId,
            );
            // Scopes the open conflict touched by the retrieved evidence to the question's own
            // subject (`scopeConflictToQuestion`, `scope-conflict-to-question.ts`): attaches only
            // when the question names exactly one canonical entity and exactly one retrieved
            // conflict group belongs to it. There is no per-claim citation to narrow the choice by
            // here (the model abstained, so there are no claims at all), only the retrieval scope
            // and the question's own text — any other case falls through to the abstention below
            // rather than guessing which property's disagreement the question meant. A narrower,
            // entity-only fallback of the check above: reached only when that one failed (no
            // metric named, or more than one group per entity+metric), so it still has something to
            // offer a question that names the entity but not a recognized metric phrase.
            const scopedGroup = scopeConflictToQuestion(
              input.questionText ?? '',
              conflictGroups,
              canonicalEntities,
            );
            if (scopedGroup) {
              return {
                outcome: {
                  kind: 'conflicting_evidence',
                  factKey: scopedGroup.factKey,
                  // `AnswerContract`'s `values` (mutable, zod-inferred) doesn't accept
                  // `ConflictedFactGroup.values`'s `readonly ConflictedFactValue[]` directly.
                  values: [...scopedGroup.values],
                },
                claims: [],
                conflictIds: [scopedGroup.conflictId],
              };
            }
          }
          return { outcome: input.outcome, claims: [] };
        }

        if (input.outcome.kind !== 'answered') {
          return { outcome: input.outcome, claims: [] };
        }

        // For the `answered` branch, `report.outcomeKind` — not `input.outcome.kind` — decides what
        // gets returned as `outcome` (and, via `answer-question.workflow.ts`, what gets persisted).
        // "The model proposes, the application disposes": a model that claimed `answered` with every
        // citation later dropped must not have that claim persisted as-is (see ADR-0004's decision
        // section for the outcome-level degradation rule this mirrors). `cellFacts` and
        // `conflictedFactKeys` are scoped to `input.retrievedChunks` and `input.tenantId` (never the
        // tenant's whole `extracted_facts`/`conflicts` collections) — see `FactsService.findCellFacts`
        // and `ConflictsService.findConflictedFactGroupsForChunks` for why that scoping is
        // load-bearing, not just an optimization; `canonicalEntities` was already loaded above for
        // the retrieval-independent check, and is reused here by the either-side widening check to
        // scope its own candidate groups to the question's subject.
        const chunkIds = input.retrievedChunks.map((chunk) => chunk.chunkId);
        const [cellFactDocs, conflictGroups] = await Promise.all([
          factsService.findCellFacts(chunkIds, input.tenantId),
          conflictsService.findConflictedFactGroupsForChunks(chunkIds, input.tenantId),
        ]);

        const cellFacts: GroundingCellFact[] = cellFactDocs.map((fact) => ({
          chunkId: fact.chunkId,
          factKey: {
            entity: fact.factKey.entity,
            metric: fact.factKey.metric,
            period: fact.factKey.period,
          },
          value: { amount: fact.value.amount, unit: fact.value.unit },
          locator: fact.locator,
        }));

        const report = groundingGateService.verify({
          outcome: input.outcome,
          retrievedChunks: input.retrievedChunks,
          cellFacts,
          conflictedFactKeys: conflictGroups.map((group) => group.factKey),
        });
        const totalClaimCount = report.claims.length + report.droppedClaims.length;

        let outcome: AnswerContract;
        // Set alongside `outcome` in whichever branch below forces `conflicting_evidence` — absent
        // (never `[]`) on every other branch, matching `GroundingCheckActivityResult.conflictIds`'s
        // own "absent whenever outcome is not that kind" contract.
        let conflictIds: readonly string[] | undefined;
        if (report.outcomeKind === 'answered') {
          // Either-side widening (ADR-0004, "SUB-DECISION"): the gate's own forcing above only ever
          // fires from `cellFacts`, deliberately `xlsx-cell`-only — see `findEitherSideConflict`'s
          // doc comment for why that stays narrow and this check runs here instead, over the same
          // `conflictGroups` already loaded, rather than widening the gate's own input. Scoped to the
          // question's single resolved entity when one exists, so a claim's own cited-chunk/numeric
          // match still can't cross a claim into a different property's conflict group.
          const eitherSideMatch = findEitherSideConflict(
            report.claims,
            conflictGroups,
            resolveQuestionEntity(input.questionText ?? '', canonicalEntities) ?? undefined,
          );
          if (eitherSideMatch) {
            outcome = {
              kind: 'conflicting_evidence',
              factKey: eitherSideMatch.factKey,
              values: [...eitherSideMatch.values],
            };
            conflictIds = [eitherSideMatch.conflictId];
          } else {
            // `input.outcome.claims` is the model's raw claim set; `report.claims` is what
            // actually survived the gate. Persisting the former here would contradict this
            // function's own doc comment above ("the application disposes") and the `claims`/
            // `verificationReport` fields returned below, which already reflect the survivors.
            outcome = { kind: 'answered', claims: [...report.claims] };
          }
        } else if (report.outcomeKind === 'insufficient_evidence') {
          outcome = {
            kind: 'insufficient_evidence',
            reason: `grounding gate verified 0 of ${totalClaimCount} claim(s); every citation failed verification`,
          };
        } else if (!report.conflictingFactKey) {
          // `GroundingReport.outcomeKind`/`conflictingFactKey` aren't a discriminated union, so `tsc`
          // can't narrow this on its own — `GroundingGateService.verify` only ever returns
          // `outcomeKind: 'conflicting_evidence'` alongside a set `conflictingFactKey` (see its own
          // implementation), so this is an invariant violation, not a normal branch.
          throw new Error(
            "GroundingGateService returned outcomeKind 'conflicting_evidence' with no " +
              'conflictingFactKey set',
          );
        } else {
          // Captured into a local rather than read as `report.conflictingFactKey` inside the closure
          // below: `tsc` doesn't carry the `else if (!report.conflictingFactKey)` narrowing above
          // through a callback passed to `.find()`.
          const conflictingFactKey = report.conflictingFactKey;
          // `conflictingFactKey` is always one of `conflictGroups`' keys (`verify` can only ever
          // have matched it against an entry from `conflictedFactKeys`, which came from
          // `conflictGroups` above) — `factKeysMatch`, not `===`/deep-equal, because the touched key
          // is the fact's own (free-text, differently-cased) key, not the conflict's canonical one.
          const matchedGroup = conflictGroups.find((group) =>
            factKeysMatch(group.factKey, conflictingFactKey),
          );
          if (!matchedGroup) {
            // Invariant violation, not a normal branch: `conflictedFactKeys` supplied to `verify`
            // above came entirely from `conflictGroups`, so a returned `conflictingFactKey` with no
            // matching group means the gate and this lookup have drifted out of sync.
            throw new Error(
              `GroundingGateService returned 'conflicting_evidence' for a fact key with no ` +
                'matching entry in conflictGroups; conflictedFactKeys and the group lookup have ' +
                'drifted out of sync',
            );
          }
          outcome = {
            kind: 'conflicting_evidence',
            factKey: matchedGroup.factKey,
            // `AnswerContract`'s `values` (mutable, zod-inferred) doesn't accept
            // `ConflictedFactGroup.values`'s `readonly ConflictedFactValue[]` directly.
            values: [...matchedGroup.values],
          };
          conflictIds = [matchedGroup.conflictId];
        }

        return {
          outcome,
          claims: report.claims,
          claimCoverage: report.claimCoverage,
          conflictIds,
          verificationReport: {
            verifiedClaimCount: report.claims.length,
            totalClaimCount,
            // `VerificationReport.droppedClaims` (mutable) doesn't accept `GroundingReport`'s
            // `readonly DroppedClaim[]` directly.
            droppedClaims: [...report.droppedClaims],
          },
        };
      }),

    persistAnswer: (input) =>
      withTenantScope(als, input.tenantId, () => answerPersistenceService.persist(input)),

    loadConflict: (input) =>
      withTenantScope(als, input.tenantId, () =>
        conflictsService.loadConflictForResolution(
          input.conflictId,
          input.winningFactId,
          input.tenantId,
        ),
      ),

    requestConflictApproval: (request) =>
      withTenantScope(als, request.tenantId, () => approvalChannel.requestApproval(request)),

    requestIngestApproval: (request) =>
      withTenantScope(als, request.tenantId, () => approvalChannel.requestApproval(request)),

    getApprovalDecision: (approvalId, tenantId) =>
      withTenantScope(als, tenantId, () => approvalChannel.getDecision(approvalId, tenantId)),

    expireApproval: (approvalId, tenantId) =>
      withTenantScope(als, tenantId, () => approvalsService.expire(approvalId, tenantId)),

    recordConflictResolution: (input) =>
      withTenantScope(als, input.tenantId, () => conflictsService.recordResolution(input)),

    // `sourceId` names no tenant of its own (`SyncSourceWorkflowInput` carries only that), so the
    // tenant to scope by is loaded fresh here via `findTenantIdForSync` before `runSync` runs.
    // Absent (the source no longer exists) short-circuits to the same `{ disabled: true, intervalMs:
    // null }` result `runSync` itself would produce, rather than opening a scope with no tenant.
    runSourceSync: async (sourceId) => {
      const tenantId = await sourcesService.findTenantIdForSync(sourceId);
      if (!tenantId) {
        return { disabled: true, intervalMs: null };
      }
      return withTenantScope(als, tenantId, () =>
        sourcesService.runSync(sourceId, new Types.ObjectId()),
      );
    },
  };
}
