import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, PipelineStage, QueryFilter } from 'mongoose';
import { Types } from 'mongoose';
import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import {
  Conflict,
  type ConflictDocument,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  type DocumentDocument,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  type DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  ExtractedFact,
  type ExtractedFactDocument,
  type ExtractionMethod,
  type FactKey,
  type FactMeasureStatus,
  type FactValue,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  DEFAULT_PAGINATION_LIMIT,
  DEFAULT_PAGINATION_SKIP,
} from '../../../shared/constants/pagination-defaults.constant';
import type { SortDirection } from '../../../shared/constants/sort.constant';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { escapeRegex } from '../../../shared/utils/escape-regex.util';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import { CanonicalEntityService } from '../facts/canonical-entity.service';
import { groupKey } from '../conflicts/detect-conflicts';
import { normalizeFactValue } from '../conflicts/normalize-fact-value';
import { parsePeriod, UNDATED_PERIOD, UNPARSEABLE_PERIOD_PREFIX } from '../facts/derive-period';
import { toMeasureDefinition, type MeasureDefinition } from '../measures/measure-definition';
import { MeasureNotFoundException } from '../measures/exceptions/measures.exception';
import { MeasuresService } from '../measures/measures.service';
import { loadFactLifecycle, type FactLifecycle } from './load-fact-lifecycle';
import {
  resolveCell,
  type CellConflictInput,
  type CellDecision,
  type CellFactInput,
  type CellValue,
  type LedgerState,
} from './resolve-cell';

/**
 * One resolved `(entity, measure, period)` cell plus the citations `resolveValue` can back it
 * with — every entry in `citations` is one `factIds` member whose provenance resolved
 * (`loadFactLifecycle`), never a placeholder for one that did not.
 */
export interface LedgerResolution {
  readonly entity: string;
  readonly measure: string;
  readonly period: string;
  readonly state: LedgerState;
  readonly value?: CellValue;
  readonly factIds: string[];
  readonly conflictId?: string;
  readonly decision?: CellDecision;
  readonly winnerWithdrawn?: boolean;
  readonly citations: LedgerCitation[];
}

/** One row `listCells` returns — the cell's resolved state, with no citation detail (that is
 *  `resolveValue`'s job, not the list view's). */
export interface LedgerCellResult {
  readonly entity: string;
  readonly measure: string;
  readonly period: string;
  readonly state: LedgerState;
  readonly value?: CellValue;
  readonly factIds: string[];
  readonly conflictId?: string;
  readonly decision?: CellDecision;
  readonly winnerWithdrawn?: boolean;
}

/** A single citation a recipient can check against bytes: `sha256` pins the exact document
 *  version `quote` was read from. Never built for a fact whose lifecycle did not resolve — see
 *  `LedgerService`'s own doc comment. */
export interface LedgerCitation {
  readonly factId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly sha256: string;
  readonly locator: EvidenceLocator;
  readonly extractorVersion: string;
  readonly quote: string;
  readonly withdrawn: boolean;
}

/** One fact as `listFacts`'s drill-down returns it, at any `measureStatus` — unlike
 *  `LedgerCellResult`/`LedgerResolution`, a proposed-measure fact is included here, labelled by
 *  its own `measureStatus`. `citation`/`withdrawn`/`superseded` are absent, not fabricated, when
 *  the fact's lifecycle does not resolve. */
export interface LedgerFactResult {
  readonly id: string;
  readonly factKey: FactKey;
  readonly value: FactValue;
  readonly canonicalAmount?: number;
  readonly rawText: string;
  readonly confidence: number;
  readonly extractionMethod: ExtractionMethod;
  readonly measureId: string;
  readonly measureVersion: number;
  readonly measureStatus: FactMeasureStatus;
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly observedAt?: Date;
  readonly entityMatched?: boolean;
  readonly citation?: LedgerCitation;
  readonly withdrawn?: boolean;
  readonly superseded?: boolean;
  readonly createdAt: Date;
}

export interface LedgerEntityResult {
  readonly entity: string;
  readonly factCount: number;
  readonly measureCount: number;
}

export interface ResolveLedgerValueInput {
  readonly tenantId: string;
  readonly entity: string;
  readonly measure: string;
  readonly period?: string;
}

/** Matches `ListLedgerCellsRequestDto`'s shape (added once the request DTO exists) — the same
 *  local-interface-ahead-of-the-DTO convention `MeasuresService.ListMeasuresParams` already
 *  establishes. */
export interface ListLedgerCellsParams {
  readonly entity?: string;
  readonly measure?: string;
  readonly state?: LedgerState;
  readonly period?: string;
  readonly sort?: string;
  readonly sortDir?: SortDirection;
  readonly skip?: number;
  readonly limit?: number;
}

export interface ListLedgerFactsParams {
  readonly entity: string;
  readonly measure: string;
  readonly period?: string;
  readonly skip?: number;
  readonly limit?: number;
}

export interface ListLedgerEntitiesParams {
  readonly skip?: number;
  readonly limit?: number;
}

interface LedgerGroupRow {
  readonly _id: string;
  readonly entity: string;
  readonly measure: string;
  readonly period: string;
  readonly factIds: Types.ObjectId[];
}

interface LedgerCellFacetResult {
  readonly docs: LedgerGroupRow[];
  readonly count: { readonly count: number }[];
}

interface LedgerEntityFacetResult {
  readonly docs: LedgerEntityResult[];
  readonly count: { readonly count: number }[];
}

function toCellConflictInput(conflict: ConflictDocument): CellConflictInput {
  return {
    id: conflict._id.toString(),
    status: conflict.status,
    factIds: conflict.factIds.map((id) => id.toString()),
    resolution: conflict.resolution,
    createdAt: conflict.createdAt,
  };
}

/** Buckets `items` by a string key, preserving each bucket's original order — used to fan
 *  batch-loaded facts and conflicts back out to the ledger group each one belongs to. */
function groupByKey<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }
  return buckets;
}

/**
 * Reads the evidence ledger: one `(entity, measure, period)` cell's current value
 * (`resolveValue`), a paginated table of cells (`listCells`), the facts behind one cell
 * (`listFacts`), and the tenant's registered entities (`listEntities`).
 *
 * Two invariants hold across every method here:
 *
 * - **The exclusion rule is asymmetric.** `resolveValue` and `listCells` filter to
 *   `measureStatus: 'confirmed'` — a fact stored under a measure no admin has confirmed never
 *   reaches a ledger answer. `listFacts` is the one deliberate exception: it is the drill-down
 *   that shows an operator what a cell is built from, including a proposed-measure fact, labelled
 *   by its own `measureStatus` rather than hidden.
 * - **`tenantId` is passed explicitly to every query below**, including every aggregation
 *   `$match`. `tenantScopePlugin` intersects a simple query's filter with the request's
 *   AsyncLocalStorage tenant, but an aggregation pipeline is not a simple query — relying on the
 *   plugin here would leave a `$match` one refactor away from running unscoped across tenants.
 *
 * A citation is built only from a fact whose `loadFactLifecycle` entry resolved; a fact whose
 * entry is `undefined` is excluded from the result it would otherwise contribute to (and logged
 * at `warn`) rather than emitted with a fabricated or blank `sha256` — see that function's own
 * doc comment for why the caller carries this obligation.
 */
@Injectable()
export class LedgerService {
  constructor(
    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    @InjectModel(Conflict.name)
    private readonly conflictModel: Model<ConflictDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    private readonly canonicalEntityService: CanonicalEntityService,
    private readonly measuresService: MeasuresService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(LedgerService.name);
  }

  async resolveValue(input: ResolveLedgerValueInput): Promise<LedgerResolution> {
    const { tenantId, entity, measure, period } = input;

    const measureDoc = await this.measuresService.findBySlug(measure, tenantId);
    if (!measureDoc || measureDoc.status === 'rejected') {
      throw new MeasureNotFoundException(`Measure '${measure}' not found`);
    }

    const [entityResolution] = await this.canonicalEntityService.resolveMany([entity], tenantId);
    const periodKey = this.resolvePeriodKey(period ?? '');

    if (measureDoc.status === 'proposed') {
      return {
        entity: entityResolution.name,
        measure,
        period: periodKey,
        state: 'unknown',
        factIds: [],
        citations: [],
      };
    }

    const groupKeyNormalized = groupKey({
      entity: entityResolution.name,
      metric: measure,
      period: periodKey,
    });

    const [facts, conflicts] = await Promise.all([
      this.extractedFactModel.find({ tenantId, groupKeyNormalized, measureStatus: 'confirmed' }),
      this.conflictModel.find({ tenantId, groupKeyNormalized }),
    ]);

    const lifecycleByFactId = await loadFactLifecycle(
      this.documentVersionModel,
      this.documentModel,
      facts,
      tenantId,
    );
    const factById = new Map(facts.map((fact) => [fact._id.toString(), fact]));
    const factInputs = this.toCellFactInputs(facts, lifecycleByFactId);
    const conflictInputs = conflicts.map(toCellConflictInput);

    const cell = resolveCell(toMeasureDefinition(measureDoc), factInputs, conflictInputs);
    const citations = this.buildCitations(cell.factIds, factById, lifecycleByFactId);

    return {
      entity: entityResolution.name,
      measure,
      period: periodKey,
      ...cell,
      citations,
    };
  }

  async listCells(
    tenantId: string,
    dto: ListLedgerCellsParams,
  ): Promise<DocumentResultWithCount<LedgerCellResult>> {
    const skip = dto.skip ?? DEFAULT_PAGINATION_SKIP;
    const limit = dto.limit ?? DEFAULT_PAGINATION_LIMIT;

    const match: QueryFilter<ExtractedFactDocument> = {
      tenantId,
      measureStatus: 'confirmed',
      ...(dto.measure ? { 'factKey.metric': dto.measure } : {}),
      ...(dto.period ? { 'factKey.period': this.resolvePeriodKey(dto.period) } : {}),
    };
    if (dto.entity) {
      const [entityResolution] = await this.canonicalEntityService.resolveMany(
        [dto.entity],
        tenantId,
      );
      match.groupKeyNormalized = {
        $regex: `^${escapeRegex(normalizeEntityName(entityResolution.name))}::`,
      };
    }

    const sort = resolveSort(dto.sort, dto.sortDir, 'entity', 'asc');
    const pipeline = this.buildGroupPipeline(match, sort);
    const measureDefsBySlug = new Map(
      (await this.measuresService.listConfirmedDefinitions(tenantId)).map((def) => [def.id, def]),
    );

    // Filtering by `state` computes every matching group's cell before paging — `state` is
    // derived from a group's facts and conflicts, never stored, so there is no index to filter on
    // directly. Bounded by the tenant's total matching group count, not by `limit`; the `$facet`
    // path below (no `state` filter) pages before resolving instead.
    if (dto.state) {
      const groups = await this.extractedFactModel.aggregate<LedgerGroupRow>(pipeline);
      const resolved = await this.resolveCellGroups(tenantId, groups, measureDefsBySlug);
      const filtered = resolved.filter((cell) => cell.state === dto.state);
      return { docs: filtered.slice(skip, skip + limit), count: filtered.length };
    }

    const [facetResult] = await this.extractedFactModel.aggregate<LedgerCellFacetResult>([
      ...pipeline,
      { $facet: { docs: [{ $skip: skip }, { $limit: limit }], count: [{ $count: 'count' }] } },
    ]);
    const groups = facetResult?.docs ?? [];
    const count = facetResult?.count?.[0]?.count ?? 0;
    const docs = await this.resolveCellGroups(tenantId, groups, measureDefsBySlug);
    return { docs, count };
  }

  async listFacts(
    tenantId: string,
    dto: ListLedgerFactsParams,
  ): Promise<DocumentResultWithCount<LedgerFactResult>> {
    const skip = dto.skip ?? DEFAULT_PAGINATION_SKIP;
    const limit = dto.limit ?? DEFAULT_PAGINATION_LIMIT;

    const [entityResolution] = await this.canonicalEntityService.resolveMany(
      [dto.entity],
      tenantId,
    );
    const periodKey = this.resolvePeriodKey(dto.period ?? '');
    const groupKeyNormalized = groupKey({
      entity: entityResolution.name,
      metric: dto.measure,
      period: periodKey,
    });
    const filter: QueryFilter<ExtractedFactDocument> = { tenantId, groupKeyNormalized };

    const [facts, count, measureDoc] = await Promise.all([
      this.extractedFactModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip,
        limit,
      }),
      this.extractedFactModel.countDocuments(filter),
      this.measuresService.findBySlug(dto.measure, tenantId),
    ]);

    const lifecycleByFactId = await loadFactLifecycle(
      this.documentVersionModel,
      this.documentModel,
      facts,
      tenantId,
    );
    const measureDef = measureDoc ? toMeasureDefinition(measureDoc) : undefined;

    return {
      docs: facts.map((fact) => this.toLedgerFactResult(fact, lifecycleByFactId, measureDef)),
      count,
    };
  }

  async listEntities(
    tenantId: string,
    dto: ListLedgerEntitiesParams,
  ): Promise<DocumentResultWithCount<LedgerEntityResult>> {
    const skip = dto.skip ?? DEFAULT_PAGINATION_SKIP;
    const limit = dto.limit ?? DEFAULT_PAGINATION_LIMIT;

    const [facetResult] = await this.extractedFactModel.aggregate<LedgerEntityFacetResult>([
      { $match: { tenantId, measureStatus: 'confirmed' } },
      {
        $group: {
          _id: '$factKey.entity',
          factCount: { $sum: 1 },
          measures: { $addToSet: '$factKey.metric' },
        },
      },
      { $project: { _id: 0, entity: '$_id', factCount: 1, measureCount: { $size: '$measures' } } },
      { $sort: { entity: 1 } },
      { $facet: { docs: [{ $skip: skip }, { $limit: limit }], count: [{ $count: 'count' }] } },
    ]);

    return {
      docs: facetResult?.docs ?? [],
      count: facetResult?.count?.[0]?.count ?? 0,
    };
  }

  /** Confirmed measures only — delegates entirely to `MeasuresService`, the one place that
   *  ordering and filtering are defined. */
  async listMeasures(tenantId: string): Promise<MeasureDefinition[]> {
    return this.measuresService.listConfirmedDefinitions(tenantId);
  }

  /** Resolves a period filter's raw value to the exact `factKey.period` key it must match.
   *  `UNDATED_PERIOD` and an `UNPARSEABLE_PERIOD_PREFIX`-prefixed value are the client's own
   *  sentinel forms (`LedgerCellResponseDto.period`, echoed straight back as a filter) — each is
   *  recognized by this method directly rather than re-read through `parsePeriod`, which would
   *  otherwise treat either as unparseable text and derive a key with an extra `undated:` layer
   *  that no stored fact carries. Only the text after the case-sensitive `undated:` prefix is
   *  normalized, so a filter typed with different case or whitespace than the stored key matches
   *  it for the prefixed form; the bare `undated` sentinel is matched exactly. Shared by
   *  `resolveValue`, `listCells` and `listFacts`, the three methods that turn a caller-supplied
   *  period into a lookup key. */
  private resolvePeriodKey(period: string): string {
    if (period === UNDATED_PERIOD) {
      return UNDATED_PERIOD;
    }
    if (period.startsWith(UNPARSEABLE_PERIOD_PREFIX)) {
      const text = period.slice(UNPARSEABLE_PERIOD_PREFIX.length);
      return `${UNPARSEABLE_PERIOD_PREFIX}${normalizeEntityName(text)}`;
    }
    return parsePeriod(period).key;
  }

  private buildGroupPipeline(
    match: QueryFilter<ExtractedFactDocument>,
    sort: Record<string, 1 | -1>,
  ): PipelineStage[] {
    return [
      { $match: match },
      {
        $group: {
          _id: '$groupKeyNormalized',
          entity: { $first: '$factKey.entity' },
          measure: { $first: '$factKey.metric' },
          period: { $first: '$factKey.period' },
          factIds: { $push: '$_id' },
        },
      },
      { $sort: sort },
    ];
  }

  /** Batch-loads the facts and conflicts behind `groups` in exactly two queries (plus
   *  `loadFactLifecycle`'s own two), then resolves each group to a cell. A group whose `measure`
   *  names no confirmed definition is skipped, at `warn` — a measure can be edited or rejected
   *  after a fact was extracted under it, and this is the one place that gap would otherwise crash
   *  the page rather than simply omitting the row. */
  private async resolveCellGroups(
    tenantId: string,
    groups: readonly LedgerGroupRow[],
    measureDefsBySlug: ReadonlyMap<string, MeasureDefinition>,
  ): Promise<LedgerCellResult[]> {
    if (groups.length === 0) {
      return [];
    }

    const allFactIds = groups.flatMap((group) => group.factIds);
    const groupKeys = groups.map((group) => group._id);
    const [facts, conflicts] = await Promise.all([
      this.extractedFactModel.find({ tenantId, _id: { $in: allFactIds } }),
      this.conflictModel.find({ tenantId, groupKeyNormalized: { $in: groupKeys } }),
    ]);
    const lifecycleByFactId = await loadFactLifecycle(
      this.documentVersionModel,
      this.documentModel,
      facts,
      tenantId,
    );
    const factsByGroup = groupByKey(facts, (fact) => fact.groupKeyNormalized);
    const conflictsByGroup = groupByKey(conflicts, (conflict) => conflict.groupKeyNormalized);

    const results: LedgerCellResult[] = [];
    for (const group of groups) {
      const measureDef = measureDefsBySlug.get(group.measure);
      if (!measureDef) {
        this.logger.warn(
          `Ledger group '${group._id}' names measure '${group.measure}' with no confirmed definition; skipping`,
        );
        continue;
      }
      const factInputs = this.toCellFactInputs(
        factsByGroup.get(group._id) ?? [],
        lifecycleByFactId,
      );
      const conflictInputs = (conflictsByGroup.get(group._id) ?? []).map(toCellConflictInput);
      const cell = resolveCell(measureDef, factInputs, conflictInputs);
      results.push({ entity: group.entity, measure: group.measure, period: group.period, ...cell });
    }
    return results;
  }

  /** Drops a fact whose lifecycle did not resolve rather than guessing its `withdrawn`/
   *  `superseded` flags — see `LedgerService`'s own doc comment. */
  private toCellFactInputs(
    facts: readonly ExtractedFactDocument[],
    lifecycleByFactId: ReadonlyMap<string, FactLifecycle | undefined>,
  ): CellFactInput[] {
    const inputs: CellFactInput[] = [];
    for (const fact of facts) {
      const id = fact._id.toString();
      const lifecycle = lifecycleByFactId.get(id);
      if (!lifecycle) {
        this.logger.warn(
          `Fact '${id}' has no resolvable lifecycle; excluding it from ledger resolution`,
        );
        continue;
      }
      inputs.push({
        id,
        value: fact.value,
        observedAt: fact.observedAt,
        createdAt: fact.createdAt,
        withdrawn: lifecycle.withdrawn,
        superseded: lifecycle.superseded,
      });
    }
    return inputs;
  }

  private buildCitations(
    factIds: readonly string[],
    factById: ReadonlyMap<string, ExtractedFactDocument>,
    lifecycleByFactId: ReadonlyMap<string, FactLifecycle | undefined>,
  ): LedgerCitation[] {
    const citations: LedgerCitation[] = [];
    for (const factId of factIds) {
      const fact = factById.get(factId);
      const lifecycle = lifecycleByFactId.get(factId);
      if (!fact || !lifecycle) {
        this.logger.warn(`Fact '${factId}' has no resolvable lifecycle; omitting its citation`);
        continue;
      }
      citations.push({
        factId,
        documentId: lifecycle.documentId,
        documentVersionId: fact.documentVersionId.toString(),
        sha256: lifecycle.sha256,
        locator: fact.locator,
        extractorVersion: fact.locator.extractorVersion,
        quote: fact.rawText,
        withdrawn: lifecycle.withdrawn,
      });
    }
    return citations;
  }

  private toLedgerFactResult(
    fact: ExtractedFactDocument,
    lifecycleByFactId: ReadonlyMap<string, FactLifecycle | undefined>,
    measureDef: MeasureDefinition | undefined,
  ): LedgerFactResult {
    const id = fact._id.toString();
    const lifecycle = lifecycleByFactId.get(id);
    if (!lifecycle) {
      this.logger.warn(`Fact '${id}' has no resolvable lifecycle; omitting its citation`);
    }

    return {
      id,
      factKey: fact.factKey,
      value: fact.value,
      canonicalAmount: measureDef ? normalizeFactValue(measureDef, fact.value) : undefined,
      rawText: fact.rawText,
      confidence: fact.confidence,
      extractionMethod: fact.extractionMethod,
      measureId: fact.measureId.toString(),
      measureVersion: fact.measureVersion,
      measureStatus: fact.measureStatus,
      periodStart: fact.periodStart,
      periodEnd: fact.periodEnd,
      observedAt: fact.observedAt,
      entityMatched: fact.entityMatched,
      citation: lifecycle
        ? {
            factId: id,
            documentId: lifecycle.documentId,
            documentVersionId: fact.documentVersionId.toString(),
            sha256: lifecycle.sha256,
            locator: fact.locator,
            extractorVersion: fact.locator.extractorVersion,
            quote: fact.rawText,
            withdrawn: lifecycle.withdrawn,
          }
        : undefined,
      withdrawn: lifecycle?.withdrawn,
      superseded: lifecycle?.superseded,
      createdAt: fact.createdAt,
    };
  }
}
