import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { QueryFilter } from 'mongoose';
import { Model, Types } from 'mongoose';
import {
  Conflict,
  ConflictDocument,
  type ConflictResolutionOutcome,
  type ConflictRuleFired,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  Document,
  DocumentDocument,
  type DocumentSourceClass,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
  type FactKey,
  type FactValue,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  Approval,
  type ApprovalDocument,
} from '../../../database/schemas/workflow/approval/approval.schema';
import { approvalTimeoutCounter } from '../../../providers/telemetry/domain-metrics';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import type { ResolveConflictWorkflowInput } from '../../../workflows/types';
import {
  ACTIVE_PACK_ID,
  ACTIVE_PACK_VERSION,
  findMetricById,
  METRIC_ONTOLOGY,
} from '../facts/metric-ontology';
import {
  WorkflowRunsService,
  type WorkflowRunResult,
} from '../workflow-runs/workflow-runs.service';
import {
  DEFAULT_CONFLICT_SORT_DIRECTION,
  DEFAULT_CONFLICT_SORT_FIELD,
  type ListConflictsRequestDto,
} from './dtos/request/list-conflicts.request.dto';
import type { ConflictValueShape } from './dtos/response/conflict.response.dto';
import { ConflictResponseDto } from './dtos/response/conflict.response.dto';
import {
  detectConflicts,
  groupKey,
  type ConflictCandidate,
  type FactForConflictScan,
  type SkippedFact,
} from './detect-conflicts';
import {
  ConflictNotFoundException,
  ConflictResolutionAlreadyPendingException,
  InvalidConflictResolutionException,
} from './exceptions/conflicts.exception';
import {
  loadFactSourceEnrichment,
  loadSourceClassByFactId,
  type FactSourceEnrichment,
} from './load-source-class-by-fact-id';
import {
  resolveConflictPolicy,
  type ConflictingFactForResolution,
  type ResolveConflictProposal,
  type SurvivorshipPolicy,
} from './resolve-conflict-policy';

/** A scannable fact carrying its `documentVersionId` alongside `detect-conflicts.ts`'s own
 *  `FactForConflictScan` shape — `detectConflicts` itself never reads the extra field (it stays a
 *  structural `FactForConflictScan` to every call into that module), but `detectAndPersist` needs
 *  it to exclude a superseded version's facts before grouping ever runs (see
 *  `excludeSupersededFacts`). Kept local to this file rather than added to `FactForConflictScan`
 *  itself: `detect-conflicts.ts` is a pure grouping/tolerance module with no document-version
 *  concept of its own. */
interface ScannableFact extends FactForConflictScan {
  readonly documentVersionId: Types.ObjectId;
}

export interface ConflictScanResult {
  readonly conflictsCreated: number;
  /** Facts `detectConflicts` could not normalize (an unrecognized unit) and dropped from this
   * scan — also logged individually at `warn` (see `scanForConflicts`), but surfaced here too so a
   * caller (the `eval` harness, a future admin surface) can assert on or alert on the count without
   * scraping logs. Zero on every run where every fact's unit was recognized. */
  readonly skippedFactCount: number;
}

/** One side of an open `Conflict`, projected for `GroundingGateService.verify`'s
 * `conflicting_evidence` outcome — shaped to match `conflictingValueSchema`
 * (`../qa/contracts/answer.contract.ts`) field-for-field. */
export interface ConflictedFactValue {
  readonly value: number;
  readonly unit: string;
  readonly sourceChunkId: string;
}

/** An open `Conflict`'s fact key plus every one of its `factIds`' current values — not just the
 * fact touched by a request's retrieved chunk, since `conflictingEvidenceOutcomeSchema` requires
 * the *whole* disagreement (`values.min(2)`), not one side of it. `conflictId` is the underlying
 * `Conflict._id` — outside `conflictingEvidenceOutcomeSchema` itself (that schema is what the
 * server persists as `Answer.outcome`), but is what `activities.ts`'s `groundingCheck` threads
 * through to `Answer.conflictIds` so a `conflicting_evidence` answer names the record that caused
 * it, not just its values. */
export interface ConflictedFactGroup {
  readonly conflictId: string;
  readonly factKey: FactKey;
  readonly values: readonly ConflictedFactValue[];
}

/** One `ExtractedFact` side of a conflict being considered for resolution — `factId` is the field
 * `ConflictedFactValue` deliberately omits (that type only ever needs to say *where* a value came
 * from, not which `ExtractedFact._id` it is); resolution needs the id to validate and record a
 * proposed winner. */
export interface ConflictResolutionValue {
  readonly factId: string;
  readonly value: number;
  readonly unit: string;
  readonly sourceChunkId: string;
}

/** Everything `resolveConflict` (`resolve-conflict.workflow.ts`) needs to build a human-readable
 * approval request and, later, record the winner — loaded and validated in one call by
 * `loadConflictForResolution` so the workflow never requests approval for a proposal that can't be
 * honored. */
export interface ConflictResolutionCandidate {
  readonly conflictId: string;
  readonly factKey: FactKey;
  readonly winningFactId: string;
  readonly values: readonly ConflictResolutionValue[];
}

export interface RecordConflictResolutionInput {
  readonly conflictId: string;
  readonly outcome: ConflictResolutionOutcome;
  /** Present only when `outcome === 'resolved'` — the `ExtractedFact._id` a human approved as the
   * correct value. */
  readonly winningFactId?: string;
  readonly decidedBy?: string;
  readonly reason?: string;
  readonly tenantId: string;
  /** The survivorship policy's proposal, captured by `requestResolution` at approval-request time
   * and carried through `ResolveConflictWorkflowInput` — never recomputed here (see
   * `recordResolution`'s own doc comment). Absent only when replaying a `resolveConflict` execution
   * that started before this capture existed. */
  readonly ruleFired?: ConflictRuleFired;
  readonly proposedWinnerFactId?: string;
}

export interface RecordConflictResolutionResult {
  readonly conflictId: string;
  readonly outcome: ConflictResolutionOutcome;
}

export interface RequestConflictResolutionInput {
  readonly conflictId: string;
  readonly winningFactId: string;
  readonly actorId: string;
  /** Threaded into `ResolveConflictWorkflowInput.requestedBy` and, eventually,
   *  `Approval.requestedBy` — the identity shown to the human deciding the proposal. An email when
   *  the caller has one to give (`ConflictsController` reads it from the session; the MCP surface
   *  reads it from the verified PAT's `ToolExecutionContext.email`), otherwise the account id. */
  readonly requestedBy: string;
  /** Which surface proposed this resolution — `'api'` for the interactive REST path, `'mcp'` for
   *  `request_resolution` (`src/mcp/mcp-tools.ts`). Threaded to `ResolveConflictWorkflowInput
   *  .requestedByOrigin` and rendered into the approval summary a reviewer reads, so "a colleague
   *  proposed this" and "an AI client holding a PAT proposed this" are never indistinguishable —
   *  see ADR-0014 § Approvals. Optional: an absent origin renders as an unlabeled proposal in the
   *  summary rather than defaulting to either surface. */
  readonly origin?: 'api' | 'mcp';
  readonly tenantId: string;
}

/**
 * `resolveConflict` — the Temporal workflow type name in `src/workflows/resolve-conflict.workflow.ts`
 * — is not exported as a runtime value from `src/workflows/**` (types only, across the determinism
 * fence). Duplicated here rather than imported, the same reasoning `qa.service.ts`'s
 * `ANSWER_QUESTION_WORKFLOW_TYPE` and `documents.service.ts`'s
 * `INGEST_DOCUMENT_VERSION_WORKFLOW_TYPE` already document.
 */
const RESOLVE_CONFLICT_WORKFLOW_TYPE = 'resolveConflict';

@Injectable()
export class ConflictsService {
  constructor(
    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    @InjectModel(Conflict.name)
    private readonly conflictModel: Model<ConflictDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    @InjectModel(Approval.name)
    private readonly approvalModel: Model<ApprovalDocument>,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly workflowRunsService: WorkflowRunsService,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(ConflictsService.name);
  }

  /**
   * Audit subject: a paginated list has no single conflict to attach the event to, so the
   * requesting user stands in as the subject rather than a fabricated ObjectId that would
   * dangle with no referent.
   */
  async list(
    dto: ListConflictsRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<ConflictResponseDto>> {
    const filter = { tenantId, ...(dto.status ? { status: dto.status } : {}) };

    const [conflicts, count] = await Promise.all([
      this.conflictModel.find(filter, null, {
        sort: resolveSort(
          dto.sort,
          dto.sortDir,
          DEFAULT_CONFLICT_SORT_FIELD,
          DEFAULT_CONFLICT_SORT_DIRECTION,
        ),
        skip: dto.skip,
        limit: dto.limit,
      }),
      this.conflictModel.countDocuments(filter),
    ]);

    let factById = new Map<string, ExtractedFactDocument>();
    let factEnrichmentByFactId = new Map<string, FactSourceEnrichment>();
    if (conflicts.length > 0) {
      const everyFactId = [
        ...new Set(conflicts.flatMap((conflict) => conflict.factIds.map((id) => id.toString()))),
      ].map((id) => new Types.ObjectId(id));
      const facts = await this.extractedFactModel.find({ _id: { $in: everyFactId }, tenantId });
      factById = new Map(facts.map((fact) => [fact._id.toString(), fact]));
      // `loadFactSourceEnrichment`, not `loadSourceClassByFactId` — a listed conflict's
      // `ConflictValueShape.withdrawn` needs the same join's withdrawal signal alongside
      // sourceClass, and this is the one call that already pays for the join's two queries.
      factEnrichmentByFactId = await loadFactSourceEnrichment(
        this.documentVersionModel,
        this.documentModel,
        facts,
        tenantId,
      );
    }

    await this.auditService.record({
      action: 'conflicts.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return {
      docs: conflicts.map((conflict) =>
        this.toConflictDto(conflict, factById, factEnrichmentByFactId),
      ),
      count,
    };
  }

  /**
   * Scans `ExtractedFact`s for one tenant, groups by `(entity, metric, period)`, and persists a
   * `Conflict` for each group whose normalized values disagree by more than the built-in
   * `METRIC_ONTOLOGY`'s tolerance for that metric — every candidate this call detects, and every
   * `Conflict` it inserts, is judged and stamped against that one fixed ontology.
   *
   * Two paths over the identical `detectConflicts` core, chosen by whether `factKeys` is
   * `undefined` (not by emptiness — `factKeys: []` is a real "this ingest produced zero facts"
   * result, and must run the cheap incremental path with an empty `$in`, never silently fall back
   * to a full scan):
   *
   * - **Incremental** (`factKeys` given): a document re-ingest re-scans only the groups its own
   *   facts belong to — via `groupKeyNormalized`, the denormalized case-insensitive grouping key
   *   indexed alongside `{tenantId, status, groupKeyNormalized}` for the idempotency check below.
   *   This is the path `ingest-document-version.workflow.ts` calls on every ingest.
   * - **Full scan** (`factKeys` omitted): every `ExtractedFact` for the tenant, streamed via a
   *   Mongoose cursor rather than one `find()` materializing the whole collection — the
   *   maintenance/eval path (`npm run eval`, an admin re-scan), not the per-ingest hot path.
   *
   * Idempotent by group, not by run: a group with an `open` `Conflict` always blocks a new one. A
   * `resolved`/`dismissed` `Conflict` blocks a new one only when its `factIds` exactly match the
   * candidate's — the disagreement is unchanged, so there is nothing new to decide. A
   * `resolved`/`dismissed` `Conflict` whose `factIds` differ from the candidate's — the group grew
   * with a genuinely new fact — does not block: new evidence is a new decision, not a repeat of an
   * old one.
   */
  async scanForConflicts(
    tenantId: string,
    factKeys?: readonly FactKey[],
  ): Promise<ConflictScanResult> {
    if (factKeys !== undefined) {
      const groupKeys = [...new Set(factKeys.map(groupKey))];
      return this.scanGroupKeys(tenantId, groupKeys);
    }

    const facts: ScannableFact[] = [];
    const cursor = this.extractedFactModel
      .find({ tenantId }, { factKey: 1, value: 1, documentVersionId: 1 })
      .cursor();
    for await (const fact of cursor) {
      facts.push(this.toFactForScan(fact));
    }
    return this.detectAndPersist(tenantId, facts, { tenantId });
  }

  private toFactForScan(fact: {
    _id: Types.ObjectId;
    factKey: FactKey;
    value: FactValue;
    documentVersionId: Types.ObjectId;
  }): ScannableFact {
    return {
      id: fact._id.toString(),
      factKey: fact.factKey,
      value: fact.value,
      documentVersionId: fact.documentVersionId,
    };
  }

  /** Shared tail of `scanForConflicts`'s `factKeys` branch: load every fact in the given
   * `groupKeyNormalized` set and hand it to `detectAndPersist`, scoped to that identical set for
   * the existing-conflict idempotency check. */
  private async scanGroupKeys(
    tenantId: string,
    groupKeys: readonly string[],
  ): Promise<ConflictScanResult> {
    const facts = await this.extractedFactModel.find(
      { tenantId, groupKeyNormalized: { $in: groupKeys } },
      { factKey: 1, value: 1, documentVersionId: 1 },
    );
    return this.detectAndPersist(
      tenantId,
      facts.map((fact) => this.toFactForScan(fact)),
      { tenantId, groupKeyNormalized: { $in: groupKeys } },
    );
  }

  private async detectAndPersist(
    tenantId: string,
    facts: readonly ScannableFact[],
    existingConflictScope: QueryFilter<ConflictDocument>,
  ): Promise<ConflictScanResult> {
    if (facts.length === 0) {
      this.logger.debug(`No conflicts detected for tenant '${tenantId}'`);
      return { conflictsCreated: 0, skippedFactCount: 0 };
    }

    const currentFacts = await this.excludeSupersededFacts(facts, tenantId);
    const { conflicts: candidates, skipped } = detectConflicts(currentFacts, METRIC_ONTOLOGY);

    // A silently-dropped fact is a fact that can never conflict — the quiet correctness loss this
    // whole scan exists to prevent — so every skip is logged individually with the context (fact
    // id, metric, unit) needed to act on it, not just counted.
    for (const { fact, reason } of skipped) {
      this.logger.warn(
        `Skipped fact '${fact.id}' (metric '${fact.factKey.metric}', unit '${fact.value.unit}') from conflict detection: ${reason}`,
      );
    }

    // Every existing conflict in `existingConflictScope`, any status — not scoped to `open` — so
    // the steps below can each act on it: retraction closes an `open` conflict whose group no
    // longer produced a candidate, growing extends an `open` conflict whose candidate gained a
    // fact, and the insert step skips a group whose most recent `resolved`/`dismissed` conflict
    // already covers the exact same `factIds` set. A `resolved`/`dismissed` conflict whose
    // `factIds` differ from a candidate's does not count as a match for that candidate — see this
    // method's own idempotency comment on `scanForConflicts`.
    const existingConflicts = await this.conflictModel.find(existingConflictScope);

    const retractable = this.findRetractableConflicts(candidates, skipped, existingConflicts);
    for (const conflict of retractable) {
      conflict.status = 'dismissed';
      conflict.resolution = {
        outcome: 'retracted',
        resolvedAt: new Date(),
        packId: ACTIVE_PACK_ID,
        packVersion: ACTIVE_PACK_VERSION,
      };
      await conflict.save();
      this.logger.debug(
        `Retracted open conflict '${conflict._id.toString()}' for tenant '${tenantId}': its group's current facts no longer disagree`,
      );
    }

    if (candidates.length === 0) {
      this.logger.debug(`No conflicts detected for tenant '${tenantId}'`);
      return { conflictsCreated: 0, skippedFactCount: skipped.length };
    }

    const { newCandidates, grown } = this.partitionCandidates(candidates, existingConflicts);

    for (const { conflict, candidate } of grown) {
      conflict.factIds = candidate.factIds.map((id) => new Types.ObjectId(id));
      conflict.magnitude = candidate.magnitude;
      conflict.magnitudeUnit = candidate.magnitudeUnit;
      await conflict.save();
      this.logger.debug(
        `Grew open conflict '${conflict._id.toString()}' to ${candidate.factIds.length} disagreeing fact(s) for tenant '${tenantId}'`,
      );
    }

    if (newCandidates.length === 0) {
      this.logger.debug(`All detected conflicts for tenant '${tenantId}' are already handled`);
      return { conflictsCreated: 0, skippedFactCount: skipped.length };
    }

    await this.conflictModel.insertMany(
      newCandidates.map((candidate) => ({
        factKey: candidate.factKey,
        groupKeyNormalized: groupKey(candidate.factKey),
        factIds: candidate.factIds.map((id) => new Types.ObjectId(id)),
        magnitude: candidate.magnitude,
        magnitudeUnit: candidate.magnitudeUnit,
        packId: ACTIVE_PACK_ID,
        packVersion: ACTIVE_PACK_VERSION,
        status: 'open',
        tenantId,
      })),
    );

    this.logger.debug(`Created ${newCandidates.length} conflicts for tenant '${tenantId}'`);

    return { conflictsCreated: newCandidates.length, skippedFactCount: skipped.length };
  }

  /**
   * Existing `open` conflicts in `existingConflicts` whose group produced no `ConflictCandidate`
   * this scan — the corrected-re-upload case `excludeSupersededFacts` exists for: the fact it
   * corrected is excluded, so the group's remaining current facts stop disagreeing (or drop below
   * two comparable values) and `detectConflicts` emits nothing for it. Without closing the
   * still-`open` row here, `ConflictsService.findConflictedFactGroupsForTenant` keeps surfacing it
   * and `groundingCheck` (`src/worker/activities.ts`) keeps forcing `conflicting_evidence` off a
   * value the source no longer states — no other write path resolves an `open` conflict that its
   * own rescan stops detecting.
   *
   * Excludes a group with a fact `detectConflicts` had to skip this scan (an unrecognized unit): a
   * skip is not evidence the disagreement resolved — `excludeSupersededFacts`'s own doc comment
   * makes the symmetric claim for the currentness check ("an unresolvable fact is not provably
   * superseded"); an unverifiable group is not provably resolved either, and retracting it would
   * silently close a disagreement that may still be live.
   */
  private findRetractableConflicts(
    candidates: readonly ConflictCandidate[],
    skipped: readonly SkippedFact[],
    existingConflicts: readonly ConflictDocument[],
  ): ConflictDocument[] {
    const candidateGroupKeys = new Set(candidates.map((candidate) => groupKey(candidate.factKey)));
    const skippedGroupKeys = new Set(skipped.map((skip) => groupKey(skip.fact.factKey)));
    return existingConflicts.filter(
      (conflict) =>
        conflict.status === 'open' &&
        !candidateGroupKeys.has(groupKey(conflict.factKey)) &&
        !skippedGroupKeys.has(groupKey(conflict.factKey)),
    );
  }

  /**
   * Drops any fact extracted from a document version that is no longer its document's
   * `currentVersionId` — without this, a corrected re-upload (a new version of the same document,
   * `DocumentsService.addVersion`) keeps disagreeing with the version it corrected, forever, on
   * every future scan, because both versions' facts share the identical `(entity, metric, period)`
   * group. `currentVersionId` is set at upload time, before ingestion (and this scan) ever runs, so
   * by the time a new version's own `scanForConflicts` call reaches here it already points at that
   * new version — the prior version's facts are what get excluded, never the new one's.
   *
   * A fact whose document or version this cannot resolve (a deleted document, a deleted version,
   * or a document with no `currentVersionId` set yet) is kept rather than dropped: this is a
   * scope-narrowing step ahead of detection, not a decision about the fact itself, and an
   * unresolvable fact is not provably superseded.
   */
  private async excludeSupersededFacts(
    facts: readonly ScannableFact[],
    tenantId: string,
  ): Promise<ScannableFact[]> {
    const versionIds = [...new Set(facts.map((fact) => fact.documentVersionId.toString()))].map(
      (id) => new Types.ObjectId(id),
    );
    const versions = await this.documentVersionModel.find(
      { _id: { $in: versionIds }, tenantId },
      { documentId: 1 },
    );
    const documentIdByVersionId = new Map(
      versions.map((version) => [version._id.toString(), version.documentId.toString()]),
    );

    const documentIds = [...new Set(documentIdByVersionId.values())].map(
      (id) => new Types.ObjectId(id),
    );
    // Same "skip the second query when there's nothing to look up" shape
    // `loadFactSourceEnrichment` uses for its identical version-then-document join.
    const documents =
      documentIds.length === 0
        ? []
        : await this.documentModel.find(
            { _id: { $in: documentIds }, tenantId },
            { currentVersionId: 1 },
          );
    const currentVersionIdByDocumentId = new Map(
      documents
        .filter((document) => document.currentVersionId)
        .map((document) => [
          document._id.toString(),
          (document.currentVersionId as Types.ObjectId).toString(),
        ]),
    );

    return facts.filter((fact) => {
      const documentId = documentIdByVersionId.get(fact.documentVersionId.toString());
      if (!documentId) {
        return true;
      }
      const currentVersionId = currentVersionIdByDocumentId.get(documentId);
      if (!currentVersionId) {
        return true;
      }
      return fact.documentVersionId.toString() === currentVersionId;
    });
  }

  /**
   * Splits `candidates` against `existingConflicts` into three outcomes: genuinely new (no
   * existing conflict for the group at all, or only `resolved`/`dismissed` ones whose `factIds`
   * don't exactly match — see `scanForConflicts`'s own idempotency comment), grown (an `open`
   * conflict already covers the group, but the candidate's recomputed `factIds` set differs from
   * it — a third, fourth, ... disagreeing fact joined the same open disagreement), and silently
   * unchanged (an `open` conflict already covers the group with the identical `factIds` set — nothing
   * to write). Pure: reads nothing, writes nothing; `detectAndPersist` performs the writes for the
   * `grown` set this returns.
   */
  private partitionCandidates(
    candidates: readonly ConflictCandidate[],
    existingConflicts: readonly ConflictDocument[],
  ): {
    newCandidates: ConflictCandidate[];
    grown: { conflict: ConflictDocument; candidate: ConflictCandidate }[];
  } {
    const openConflictByGroupKey = new Map<string, ConflictDocument>();
    const closedFactIdSetsByGroupKey = new Map<string, Set<string>[]>();
    for (const conflict of existingConflicts) {
      const key = groupKey(conflict.factKey);
      if (conflict.status === 'open') {
        openConflictByGroupKey.set(key, conflict);
        continue;
      }
      const sets = closedFactIdSetsByGroupKey.get(key) ?? [];
      sets.push(new Set(conflict.factIds.map((id) => id.toString())));
      closedFactIdSetsByGroupKey.set(key, sets);
    }

    const newCandidates: ConflictCandidate[] = [];
    const grown: { conflict: ConflictDocument; candidate: ConflictCandidate }[] = [];

    for (const candidate of candidates) {
      const key = groupKey(candidate.factKey);
      const openConflict = openConflictByGroupKey.get(key);
      if (openConflict) {
        const existingFactIdSet = new Set(openConflict.factIds.map((id) => id.toString()));
        const isUnchanged =
          existingFactIdSet.size === candidate.factIds.length &&
          candidate.factIds.every((factId) => existingFactIdSet.has(factId));
        if (!isUnchanged) {
          grown.push({ conflict: openConflict, candidate });
        }
        continue;
      }

      const closedFactIdSets = closedFactIdSetsByGroupKey.get(key);
      const alreadyRecorded = closedFactIdSets?.some(
        (factIdSet) =>
          factIdSet.size === candidate.factIds.length &&
          candidate.factIds.every((factId) => factIdSet.has(factId)),
      );
      if (!alreadyRecorded) {
        newCandidates.push(candidate);
      }
    }

    return { newCandidates, grown };
  }

  /**
   * Open conflicts touched by a request's retrieved evidence, scoped to `chunkIds` and
   * `tenantId`. "Touched" means at least one of the conflict's `factIds` was extracted from one of
   * `chunkIds` — a request must never be able to force `conflicting_evidence` off a conflict in a
   * document it never retrieved, so this deliberately does not scan the tenant's whole `conflicts`
   * collection. `resolved`/`dismissed` conflicts are excluded for the same reason
   * `scanForConflicts` treats them as already handled.
   */
  async findConflictedFactGroupsForChunks(
    chunkIds: readonly string[],
    tenantId: string,
  ): Promise<ConflictedFactGroup[]> {
    if (chunkIds.length === 0) {
      return [];
    }

    const touchedFacts = await this.extractedFactModel.find(
      { chunkId: { $in: [...chunkIds] }, tenantId },
      { _id: 1 },
    );
    if (touchedFacts.length === 0) {
      return [];
    }

    const conflicts = await this.conflictModel.find({
      tenantId,
      status: 'open',
      factIds: { $in: touchedFacts.map((fact) => fact._id) },
    });
    // FAILS CLOSED: this decides one request's outcome off one specific conflict, so a `factIds`
    // reference that no longer resolves must abort rather than silently understate the
    // disagreement — see `projectConflictedFactGroups`'s own doc comment for the contrast with
    // `findConflictedFactGroupsForTenant` below.
    return this.projectConflictedFactGroups(conflicts, tenantId, { failClosed: true });
  }

  /**
   * Every one of a tenant's `open` conflicts, projected the identical way
   * `findConflictedFactGroupsForChunks` projects a chunk-touched subset of them — but never scoped
   * by which chunks a given request happened to retrieve. `findConflictedFactGroupsForChunks`
   * alone means a conflicting document that never lands in a request's top-k retrieval can never
   * force `conflicting_evidence`, because a conflict only "counts" there when a retrieved chunk's
   * own fact is one of its `factIds`. This scans the tenant's whole `conflicts` collection instead
   * — accepted at the current corpus size the same way `scanForConflicts`'s own full-scan cursor
   * path is — so `activities.ts`'s `groundingCheck` can force a `conflicting_evidence` outcome off
   * the question's own resolved entity and metric, independent of retrieval.
   *
   * FAILS OPEN on a conflict whose `factIds` no longer fully resolve: this runs ahead of every
   * question the tenant asks, not one specific request, so one corrupted row must not throw for
   * every unrelated question — see `projectConflictedFactGroups`'s own doc comment.
   */
  async findConflictedFactGroupsForTenant(tenantId: string): Promise<ConflictedFactGroup[]> {
    const conflicts = await this.conflictModel.find({ tenantId, status: 'open' });
    return this.projectConflictedFactGroups(conflicts, tenantId, { failClosed: false });
  }

  /**
   * Shared tail of `findConflictedFactGroupsForChunks` and `findConflictedFactGroupsForTenant`:
   * given a set of `open` conflicts already scoped by tenant, loads every one of their disagreeing
   * facts in one batched `$in` query and projects each conflict into a {@link ConflictedFactGroup}.
   *
   * `failClosed` sets what happens to a conflict whose `factIds` don't all still resolve to an
   * `ExtractedFact` — a data-integrity fault (a direct write, a partial delete, a bug), not a
   * normal degradation path. `findConflictedFactGroupsForChunks` passes `true`: its caller is
   * deciding one specific request's outcome off one specific conflict, and
   * `conflictingEvidenceOutcomeSchema` requires >= 2 `values`, so silently persisting a group short
   * of the conflict's real `factIds` would emit either a schema-invalid outcome or a
   * `conflicting_evidence` answer that understates a real disagreement (mirrors
   * `EvidenceRetrievalService`'s deleted-version throw). `findConflictedFactGroupsForTenant` passes
   * `false`: it loads every open conflict in the tenant ahead of every question that tenant asks,
   * so the same throw there would fail every unrelated question off one bad row — the unresolvable
   * conflict is logged and skipped instead, and every other group still gets projected.
   */
  private async projectConflictedFactGroups(
    conflicts: readonly ConflictDocument[],
    tenantId: string,
    { failClosed }: { readonly failClosed: boolean },
  ): Promise<ConflictedFactGroup[]> {
    if (conflicts.length === 0) {
      return [];
    }

    const everyFactId = [
      ...new Set(conflicts.flatMap((conflict) => conflict.factIds.map((id) => id.toString()))),
    ].map((id) => new Types.ObjectId(id));
    const conflictingFacts = await this.extractedFactModel.find({
      _id: { $in: everyFactId },
      tenantId,
    });
    const factById = new Map(conflictingFacts.map((fact) => [fact._id.toString(), fact]));

    const groups: ConflictedFactGroup[] = [];
    for (const conflict of conflicts) {
      const values: ConflictedFactValue[] = [];
      for (const id of conflict.factIds) {
        const fact = factById.get(id.toString());
        if (!fact) {
          continue;
        }
        values.push({
          value: fact.value.amount,
          unit: fact.value.unit,
          sourceChunkId: fact.chunkId,
        });
      }

      if (values.length < conflict.factIds.length) {
        const message = `Conflict '${conflict._id.toString()}' references ${conflict.factIds.length} fact(s), but only ${values.length} still resolve to an ExtractedFact`;
        if (failClosed) {
          throw new InternalServerErrorException(message);
        }
        this.logger.warn(`Skipping unresolvable conflict for tenant '${tenantId}': ${message}`);
        continue;
      }

      groups.push({
        conflictId: conflict._id.toString(),
        factKey: {
          entity: conflict.factKey.entity,
          metric: conflict.factKey.metric,
          period: conflict.factKey.period,
        },
        values,
      });
    }
    return groups;
  }

  /**
   * Loads the `open` conflict `resolveConflict` (`resolve-conflict.workflow.ts`) is gating, and
   * validates the caller's proposed `winningFactId` before any approval is requested — there is no
   * point asking a human to approve a proposal that doesn't even reference one of this conflict's
   * own facts. Fails closed on every invalid state: missing conflict, a conflict already decided
   * by an earlier resolution attempt (`status !== 'open'`), an unknown/malformed `winningFactId`,
   * or one that isn't among `conflict.factIds`. A `factIds` reference that no longer resolves to an
   * `ExtractedFact` is a data-integrity fault, not a normal branch — same reasoning
   * `findConflictedFactGroupsForChunks` applies to its own identical check above.
   */
  async loadConflictForResolution(
    conflictId: string,
    winningFactId: string,
    tenantId: string,
  ): Promise<ConflictResolutionCandidate> {
    if (!Types.ObjectId.isValid(conflictId)) {
      throw new ConflictNotFoundException(`Conflict '${conflictId}' not found`);
    }

    const conflict = await this.conflictModel.findOne({ _id: conflictId, tenantId });
    if (!conflict) {
      throw new ConflictNotFoundException(`Conflict '${conflictId}' not found`);
    }

    if (conflict.status !== 'open') {
      throw new InvalidConflictResolutionException(
        `Conflict '${conflictId}' is '${conflict.status}', not 'open' — it cannot be resolved again`,
      );
    }

    if (
      !Types.ObjectId.isValid(winningFactId) ||
      !conflict.factIds.some((factId) => factId.equals(winningFactId))
    ) {
      throw new InvalidConflictResolutionException(
        `'${winningFactId}' is not one of conflict '${conflictId}''s disagreeing facts`,
      );
    }

    const facts = await this.extractedFactModel.find({
      _id: { $in: conflict.factIds },
      tenantId,
    });
    if (facts.length < conflict.factIds.length) {
      throw new InternalServerErrorException(
        `Conflict '${conflictId}' references ${conflict.factIds.length} fact(s), but only ${facts.length} still resolve to an ExtractedFact`,
      );
    }

    return {
      conflictId: conflict._id.toString(),
      factKey: {
        entity: conflict.factKey.entity,
        metric: conflict.factKey.metric,
        period: conflict.factKey.period,
      },
      // Normalized to the canonical lowercase hex form: `Types.ObjectId.isValid` and
      // `factId.equals()` above both accept uppercase hex, but `values[].factId` below is always
      // `_id.toString()` (lowercase). A caller's uppercase `winningFactId` would otherwise survive
      // validation here and then fail every downstream `===` comparison against `factId`.
      winningFactId: new Types.ObjectId(winningFactId).toString(),
      values: facts.map((fact) => ({
        factId: fact._id.toString(),
        value: fact.value.amount,
        unit: fact.value.unit,
        sourceChunkId: fact.chunkId,
      })),
    };
  }

  /**
   * D3 of the approvals milestone: `POST /conflicts/:id/resolution-requests`. Validates the
   * proposal via `loadConflictForResolution` (the same fail-closed checks `resolveConflict`'s own
   * `loadConflict` activity applies) before ever starting a workflow — no point starting a
   * `resolveConflict` execution, and no point creating a `WorkflowRun` row for it, for a proposal
   * that can't be honored. Also refuses when a pending `Approval` already exists for this conflict
   * (`ConflictResolutionAlreadyPendingException`) — a conflict stays `open` for its entire
   * 24-hour approval wait, so without this check every call in that window starts its own
   * `resolveConflict` execution and its own pending row, each independently approvable; two
   * approvals could then name different `winningFactId`s and both reach `recordResolution`.
   * `workflowEngine.start` never chooses the winner (see `ResolveConflictWorkflowInput`'s own doc
   * comment); it only starts the gate. The returned `WorkflowRunResult` — from
   * `WorkflowRunsService.create`, this collection's first writer — gives the caller an id to poll
   * `GET /workflow-runs/:id` with.
   *
   * `computeProposalForConflict` runs here, once, before the workflow's 24-hour approval wait
   * begins — the resulting `ruleFired`/`proposedWinnerFactId` travel through
   * `ResolveConflictWorkflowInput` to `recordResolution` unchanged (see that method's own doc
   * comment for why it never recomputes them itself).
   */
  async requestResolution(input: RequestConflictResolutionInput): Promise<WorkflowRunResult> {
    const tenantId = input.tenantId;

    const candidate = await this.loadConflictForResolution(
      input.conflictId,
      input.winningFactId,
      tenantId,
    );

    const alreadyPending = await this.approvalModel.exists({
      tenantId,
      state: 'pending',
      'subject.entityType': 'Conflict',
      'subject.entityId': new Types.ObjectId(input.conflictId),
    });
    if (alreadyPending) {
      throw new ConflictResolutionAlreadyPendingException(
        `Conflict '${input.conflictId}' already has a pending resolution approval`,
      );
    }

    const proposal = await this.computeProposalForConflict(
      {
        factIds: candidate.values.map((value) => new Types.ObjectId(value.factId)),
        factKey: candidate.factKey,
      },
      tenantId,
    );

    const handle = await this.workflowEngine.start(RESOLVE_CONFLICT_WORKFLOW_TYPE, {
      conflictId: input.conflictId,
      winningFactId: input.winningFactId,
      requestedBy: input.requestedBy,
      requestedByOrigin: input.origin,
      tenantId,
      ruleFired: proposal.ruleFired,
      proposedWinnerFactId:
        proposal.ruleFired === 'none' ? undefined : proposal.proposedWinnerFactId,
    } satisfies ResolveConflictWorkflowInput);

    const run = await this.workflowRunsService.create({
      workflowId: handle.id,
      workflowType: 'resolve-conflict',
      status: handle.status,
      tenantId,
    });

    await this.auditService.record({
      action: 'conflicts.resolution_requested',
      actorId: input.actorId,
      subject: { entityType: 'Conflict', entityId: input.conflictId },
      tenantId,
    });

    this.logger.debug(
      `Started resolveConflict workflow '${handle.id}' for conflict '${input.conflictId}'`,
    );

    return run;
  }

  /**
   * Persists the outcome `resolveConflict` reached after waking from its approval wait — called
   * exactly once per workflow run, on every branch (`resolved`, `rejected`, `timed_out`), so a
   * conflict that was gated on but never got a timely human answer still carries a durable record
   * of the attempt. Only `outcome: 'resolved'` also flips `status` to `'resolved'`:
   * `rejected`/`timed_out` leave the conflict `open` (a rejection or a timeout is not a
   * resolution), but the attempt is still worth recording so a reviewer can see what already
   * happened. Fails closed on a missing conflict — same reasoning as
   * `AnswerPersistenceService.persist`: a missing row here means the id this activity was called
   * with doesn't match a real conflict, and silently no-op-ing would hide that.
   *
   * `ruleFired`/`followedProposal` are never recomputed here — `input.ruleFired` and
   * `input.proposedWinnerFactId` are exactly what `requestResolution` captured before the
   * workflow's 24-hour approval wait began (carried through `ResolveConflictWorkflowInput`), so a
   * reclassification or any other change to the conflict's facts during that wait can't retroactively
   * rewrite what was actually proposed to the reviewer. `followedProposal` is set only when the
   * outcome is `resolved` and a proposal was actually captured (`input.proposedWinnerFactId` is
   * present) — `rejected`/`timed_out`, a `'none'` proposal, and a stale pre-capture history (see
   * `ResolveConflictWorkflowInput`'s own doc comment) all leave it absent rather than fabricate a
   * `false`.
   *
   * Refuses, on every outcome, a conflict already dismissed as `'retracted'` — a machine
   * retraction (`detectAndPersist`'s `findRetractableConflicts`, run from every `scanForConflicts`
   * call) closing an `open` conflict whose group stopped disagreeing, not a human decision.
   * `loadConflictForResolution` checked `status === 'open'` only at request time, up to 24 hours
   * before this call; a status change can land in between, and this activity runs regardless of
   * that (`resolveConflict` never re-checks status before waking). Without this guard a late
   * `resolved`/`rejected`/`timed_out` write would silently overwrite the retraction's provenance
   * even though `status` itself never moves off `'dismissed'`.
   */
  async recordResolution(
    input: RecordConflictResolutionInput,
  ): Promise<RecordConflictResolutionResult> {
    const tenantId = input.tenantId;
    if (!Types.ObjectId.isValid(input.conflictId)) {
      throw new ConflictNotFoundException(`Conflict '${input.conflictId}' not found`);
    }

    const conflict = await this.conflictModel.findOne({ _id: input.conflictId, tenantId });
    if (!conflict) {
      throw new ConflictNotFoundException(`Conflict '${input.conflictId}' not found`);
    }

    if (conflict.status === 'dismissed' && conflict.resolution?.outcome === 'retracted') {
      throw new InvalidConflictResolutionException(
        `Conflict '${input.conflictId}' was already retracted and cannot be recorded as ` +
          `'${input.outcome}'`,
      );
    }

    const followedProposal =
      input.outcome === 'resolved' && input.proposedWinnerFactId !== undefined
        ? input.proposedWinnerFactId === input.winningFactId
        : undefined;

    conflict.resolution = {
      outcome: input.outcome,
      winningFactId: input.winningFactId ? new Types.ObjectId(input.winningFactId) : undefined,
      decidedBy: input.decidedBy,
      reason: input.reason,
      resolvedAt: new Date(),
      ruleFired: input.ruleFired,
      followedProposal,
    };

    if (input.outcome === 'resolved') {
      conflict.status = 'resolved';
    }

    if (input.outcome === 'timed_out') {
      // `ruleFired` is the fixed three-value `ConflictRuleFired` `requestResolution` captured
      // before the approval wait began — an operational fact (a human never came), not an error.
      approvalTimeoutCounter.add(1, { ruleFired: input.ruleFired ?? 'none' });
    }

    await conflict.save();

    this.logger.debug(
      `Recorded '${input.outcome}' resolution attempt for conflict '${input.conflictId}'`,
    );

    return { conflictId: input.conflictId, outcome: input.outcome };
  }

  /**
   * Pure given its inputs: looks up `metricId` in the built-in `METRIC_ONTOLOGY` and calls
   * `resolveConflictPolicy` with the metric's own `authorityOrder`/`stalenessWindowMs` as the
   * survivorship policy. `metricId` (from `Conflict.factKey.metric`, stored as a plain string on
   * the schema) is not guaranteed to be a metric the ontology still defines — the ontology can
   * change between when a conflict was detected (stamped on `Conflict.packId`/`packVersion`, see
   * that field's own doc comment on staleness) and when this runs. The `?? { authorityOrder:
   * undefined, stalenessWindowMs: Infinity }` fallback produces exactly the `ruleFired: 'none'` a
   * genuinely unconfigured metric already gets, rather than throw for a case that isn't a
   * data-integrity fault — this method only ever proposes, never gates.
   */
  private computeConflictProposal(
    candidates: readonly ConflictingFactForResolution[],
    metricId: string,
  ): ResolveConflictProposal {
    const metric = findMetricById(METRIC_ONTOLOGY, metricId);
    const policy: SurvivorshipPolicy = {
      authorityOrder: metric?.authorityOrder,
      stalenessWindowMs: metric?.stalenessWindowMs ?? Number.POSITIVE_INFINITY,
    };
    return resolveConflictPolicy(candidates, policy);
  }

  /**
   * `requestResolution`'s own proposal computation, run once at approval-request time (see that
   * method's doc comment for why the result then travels through the workflow rather than being
   * recomputed later) — loads this one conflict's current facts and reduces to
   * `computeConflictProposal`. Takes the minimal shape a proposal needs, not a full
   * `ConflictDocument`, so a caller that only has a `ConflictResolutionCandidate` in hand (as
   * `requestResolution` does) doesn't need a second full conflict read to supply this. A fact that
   * no longer resolves just narrows the candidate set `resolveConflictPolicy` sees, which already
   * degrades to `ruleFired: 'none'` on its own — this never throws, unlike `toConflictDto`'s
   * read-path integrity check.
   */
  private async computeProposalForConflict(
    conflict: { readonly factIds: readonly Types.ObjectId[]; readonly factKey: FactKey },
    tenantId: string,
  ): Promise<ResolveConflictProposal> {
    const facts = await this.extractedFactModel.find({
      _id: { $in: conflict.factIds },
      tenantId,
    });
    const sourceClassByFactId = await loadSourceClassByFactId(
      this.documentVersionModel,
      this.documentModel,
      facts,
      tenantId,
    );
    // `loadSourceClassByFactId` sets an entry for every fact in the array it was given, and
    // `facts` is that exact array — the lookup below can never miss, so `as` (not `??`) keeps
    // TypeScript satisfied without an untestable fallback branch.
    const candidates: ConflictingFactForResolution[] = facts.map((fact) => ({
      id: fact._id.toString(),
      sourceClass: sourceClassByFactId.get(fact._id.toString()) as DocumentSourceClass,
      observedAt: fact.observedAt,
    }));
    return this.computeConflictProposal(candidates, conflict.factKey.metric);
  }

  private toConflictDto(
    conflict: ConflictDocument,
    factById: Map<string, ExtractedFactDocument>,
    factEnrichmentByFactId: Map<string, FactSourceEnrichment>,
  ): ConflictResponseDto {
    const values: ConflictValueShape[] = [];
    const candidates: ConflictingFactForResolution[] = [];
    for (const id of conflict.factIds) {
      const fact = factById.get(id.toString());
      if (!fact) {
        continue;
      }
      // Same guarantee `computeProposalForConflict`'s identical lookup documents:
      // `factEnrichmentByFactId` is built (in `list`) from the same batch of facts `factById` was,
      // so a fact resolving above always has an entry here too. Withdrawal is display-only — this
      // never changes `status`, `factIds`, or which fact the survivorship policy proposes.
      const enrichment = factEnrichmentByFactId.get(fact._id.toString()) as FactSourceEnrichment;
      values.push({
        factId: fact._id.toString(),
        value: fact.value.amount,
        unit: fact.value.unit,
        sourceChunkId: fact.chunkId,
        documentVersionId: fact.documentVersionId.toString(),
        locator: fact.locator,
        withdrawn: enrichment.withdrawn,
      });
      candidates.push({
        id: fact._id.toString(),
        sourceClass: enrichment.sourceClass,
        observedAt: fact.observedAt,
      });
    }

    // A conflict's `packId`/`packVersion` are stamped at detection time (`detectAndPersist`) and
    // never rewritten in place — a row detected under an older ontology stamp than the current
    // `ACTIVE_PACK_ID`/`ACTIVE_PACK_VERSION` is stale: the ontology that would run against this
    // group's facts today may no longer treat them as a disagreement at all. Independent of
    // `unscorable` below and computed for every row, including one — staleness and evidence
    // integrity are unrelated failure modes and a row can carry either, both, or neither.
    const stale =
      conflict.packId !== ACTIVE_PACK_ID || conflict.packVersion !== ACTIVE_PACK_VERSION;

    const base = {
      id: conflict._id.toString(),
      // Spread rather than pass `conflict.factKey` through by reference: unlike
      // `ExtractedFact.factKey` (which uses an explicit `{ _id: false }` sub-schema), this path's
      // inline `{ type: {...} }` shorthand lets Mongoose mint an `_id` on the nested subdocument
      // — spreading the three declared fields keeps that stray id out of the response.
      factKey: {
        entity: conflict.factKey.entity,
        metric: conflict.factKey.metric,
        period: conflict.factKey.period,
      },
      factIds: conflict.factIds.map((id) => id.toString()),
      values,
      magnitude: conflict.magnitude,
      magnitudeUnit: conflict.magnitudeUnit,
      status: conflict.status,
      createdAt: conflict.createdAt,
      stale,
      staleReason: stale
        ? `Detected under pack '${conflict.packId}' v${conflict.packVersion}; the active pack is ` +
          `now '${ACTIVE_PACK_ID}' v${ACTIVE_PACK_VERSION}.`
        : undefined,
    };

    if (values.length < conflict.factIds.length) {
      // FAILS OPEN: this is a display path, not a decision path — rendering a list must never 500
      // the whole page over one corrupted row. `DocumentsService.remove` keeps every conflict's
      // `factIds` in sync with the facts it deletes, but a row that arrived some other way (a
      // direct write, a bug elsewhere) is always possible, and the whole page must still render
      // around it. The row is still returned, marked `unscorable` rather than silently dropped, so
      // a reviewer can see the conflict existed and that its evidence is gone. Contrast
      // `findConflictedFactGroupsForChunks` and `loadConflictForResolution` below: both stay
      // fail-CLOSED, because each backs a decision (grounding a live answer, proposing a resolution
      // winner) that must not proceed on an incomplete fact set.
      const missing = conflict.factIds.length - values.length;
      return {
        ...base,
        unscorable: true,
        unscorableReason: `${missing} of ${conflict.factIds.length} disagreeing fact(s) no longer resolve to an ExtractedFact.`,
      };
    }

    // Computed fresh on every read, never persisted: the built-in ontology's `authorityOrder` and a
    // document's `sourceClass` both change over time, so a stored proposal would silently go stale
    // and a reviewer could act on a rule that no longer applies.
    const proposal = this.computeConflictProposal(candidates, conflict.factKey.metric);

    return {
      ...base,
      unscorable: false,
      proposedWinnerFactId:
        proposal.ruleFired === 'none' ? undefined : proposal.proposedWinnerFactId,
      ruleFired: proposal.ruleFired,
      explanation: proposal.explanation,
    };
  }
}
