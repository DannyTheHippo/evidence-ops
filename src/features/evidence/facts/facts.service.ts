import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import type { XlsxCellLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  ExtractedFact,
  ExtractedFactDocument,
  type FactKey,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../../../providers/model/model-provider.interface';
import {
  DOCUMENT_STORE,
  type DocumentStore,
} from '../../../providers/storage/document-store.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { mapWithConcurrency } from '../../../shared/utils/map-with-concurrency.util';
import { groupKey } from '../conflicts/detect-conflicts';
import { ParserRegistry } from '../ingestion/parser.registry';
import type { ParsedElement } from '../ingestion/parsers/parsed-element.type';
import type { MeasureStamp } from '../measures/measure-definition';
import { MeasuresService, type ExtractionMeasureContext } from '../measures/measures.service';
import { CanonicalEntityService } from './canonical-entity.service';
import { parsePeriodKey } from './derive-period';
import { DocumentVersionNotFoundException } from './exceptions/facts.exception';
import { harvestParentheticalAliases } from './harvest-parenthetical-aliases';
import { ACTIVE_PACK_ID, ACTIVE_PACK_VERSION } from './metric-ontology';
import { extractProseFacts, type ProseFactExtractionResult } from './prose-fact-extractor';
import { findXlsxRegionChunk, parseRowFromCellAddress } from './resolve-xlsx-fact-chunk';
import { extractXlsxFacts, type FactCandidate } from './xlsx-fact-extractor';

export interface FactsExtractionResult {
  readonly factsCreated: number;
  /** True when this call was a no-op because the version was already extracted. */
  readonly alreadyExtracted: boolean;
  /** Prose chunks dropped because fewer than 2 of `extractProseFacts`'s 3 passes returned usable
   * output — mirrors `ConflictScanResult.skippedFactCount`'s role: a visible count rather than a
   * silent zero, so an operator can tell "this version genuinely has no facts" apart from "the
   * model was too unreliable on some of it to trust". Always 0 for a spreadsheet version. */
  readonly skippedChunkCount: number;
  /** The `factKey`s this call's facts belong to — real keys on every branch, including the
   * `alreadyExtracted` no-op (loaded via a `{factKey: 1}`-projected query, never `[]`): an
   * activity-timeout retry that lands on the no-op branch still needs to hand
   * `ConflictsService.scanForConflicts`'s incremental path something to scan, or the retried
   * ingest silently scans nothing and a conflict goes undetected. `ingest-document-version
   * .workflow.ts` threads this straight into the `scanForConflicts` activity call. */
  readonly factKeys: readonly FactKey[];
}

/** A candidate ready to persist: tied to the chunk it came from, and with its `factKey.entity`
 * already resolved against the tenant's `CanonicalEntity` registry — the shape both the
 * spreadsheet and the prose path converge on, whichever point in their own pipeline that
 * resolution happened at. */
type CanonicalizedCandidate = FactCandidate & {
  readonly chunkId: string;
  readonly entityMatched: boolean;
};

@Injectable()
export class FactsService {
  constructor(
    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(EvidenceChunk.name)
    private readonly evidenceChunkModel: Model<EvidenceChunkDocument>,

    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    @Inject(DOCUMENT_STORE)
    private readonly documentStore: DocumentStore,

    @Inject(MODEL_PROVIDER)
    private readonly modelProvider: ModelProvider,

    private readonly parserRegistry: ParserRegistry,

    private readonly canonicalEntityService: CanonicalEntityService,

    private readonly config: TypedConfigService,

    private readonly logger: AppLogger,

    private readonly measuresService: MeasuresService,
  ) {
    this.logger.init(FactsService.name);
  }

  /**
   * Loads a version's bytes, re-parses them, and derives `ExtractedFact`s: deterministically for
   * a spreadsheet, via the model for prose. Idempotent by existence check, and rolled back on a
   * partial insert failure — the same pattern `IngestionService.ingestVersion` uses, for the same
   * reason (see its own doc comment).
   *
   * Runs after ingestion, not instead of it: prose extraction needs the persisted
   * `EvidenceChunk`s (both as the unit of text sent to the model and as the required
   * `ExtractedFact.chunkId` reference), so a version with no ingested chunks yet is a precondition
   * failure, not an empty result.
   *
   * `abortSignal`, when given, is checked before every chunk's model call on the prose path
   * (`buildProseCandidates`'s `mapWithConcurrency` callback) — an already-aborted signal rejects
   * before any chunk in flight starts a new call, and an abort mid-run stops further calls from
   * starting while calls already in flight still finish. The spreadsheet path makes no model call
   * and never checks it.
   */
  async extractFacts(
    documentVersionId: string,
    tenantId: string,
    abortSignal?: AbortSignal,
  ): Promise<FactsExtractionResult> {
    if (!Types.ObjectId.isValid(documentVersionId)) {
      throw new DocumentVersionNotFoundException(
        `Document version '${documentVersionId}' not found`,
      );
    }

    const version = await this.documentVersionModel.findOne({
      _id: documentVersionId,
      tenantId,
    });
    if (!version) {
      throw new DocumentVersionNotFoundException(
        `Document version '${documentVersionId}' not found`,
      );
    }

    // Loaded, not just counted: the no-op branch below must hand back the existing facts'
    // `factKey`s so a retried ingest (an activity-timeout retry landing on this branch, or a
    // second upload of the same version) still gives `scanForConflicts` real groups to scan —
    // returning `[]` here would make a retry silently scan nothing (see this method's own
    // `factKeys` field doc comment on `FactsExtractionResult`).
    const existingFacts = await this.extractedFactModel.find(
      { documentVersionId: version._id, tenantId: version.tenantId },
      { factKey: 1 },
    );
    if (existingFacts.length > 0) {
      this.logger.debug(
        `Document version '${documentVersionId}' already has ${existingFacts.length} facts; skipping`,
      );
      return {
        factsCreated: 0,
        alreadyExtracted: true,
        skippedChunkCount: 0,
        factKeys: existingFacts.map((fact) => ({
          entity: fact.factKey.entity,
          metric: fact.factKey.metric,
          period: fact.factKey.period,
        })),
      };
    }

    const stored = await this.documentStore.get(version.storageKey);
    if (!stored) {
      // Same class of impossible state as `IngestionService`'s identical check: `storageKey` only
      // ever comes from a confirmed `documentStore.put()`, so a miss here means the store lost
      // bytes it already confirmed writing.
      throw new InternalServerErrorException(
        `Document version '${documentVersionId}' has no resolvable content in the document store`,
      );
    }

    const parser = this.parserRegistry.resolve(stored.contentType);
    const parsed = await parser.parse(stored.content);

    // Ahead of candidate building, so that with auto-application on, a definition this document
    // states resolves the facts this same document produces.
    await this.harvestAliases(parsed.elements, version._id, tenantId);

    // The tenant's extraction allowlist: `confirmed` for the prose ontology, `matchable`
    // (confirmed + proposed) plus `rejectedSlugs` for the deterministic xlsx path's header
    // resolution and proposal gate.
    const context = await this.measuresService.loadExtractionContext(tenantId);

    const isSpreadsheet = parsed.elements[0]?.locator.kind === 'xlsx-cell';
    let candidates: CanonicalizedCandidate[];
    let skippedChunkCount = 0;
    // Populated only on the xlsx path, from `proposeMany`'s newly-minted or already-proposed
    // stamps — the prose path proposes nothing, so this stays empty for it.
    let proposalStamps = new Map<string, MeasureStamp>();
    if (isSpreadsheet) {
      const xlsx = await this.buildXlsxCandidates(version._id, parsed.elements, tenantId, context);
      // The deterministic path resolves entities here, at the end of extraction, because it has no
      // agreement step to run ahead of: one lookup covers the whole sheet. The prose path resolves
      // earlier — inside `extractProseFacts`, before its passes are compared — since agreement is
      // keyed on the entity name. Both go through `CanonicalEntityService.resolveMany`, so neither
      // can resolve an entity differently from the other.
      candidates = await this.canonicalizeCandidateEntities(xlsx.candidates, tenantId);
      proposalStamps = xlsx.proposalStamps;
      // Recorded before the empty-candidates return below: an ambiguous header or an unresolvable
      // cell unit is a fidelity signal about the sheet itself, independent of whether any row went
      // on to produce a fact. `$addToSet`/`$each` rather than `$set` — `reducedFidelityReasons` may
      // already carry `IngestionService.finalizeCompletion`'s parser-time entries (extraction always
      // runs after ingestion completes; `ingest-document-version.workflow.ts` awaits `ingestVersion`
      // before `extractFacts`), and appending rather than overwriting means this write is correct
      // regardless of which pipeline stage's reasons land first.
      if (xlsx.reducedFidelityReasons.length > 0) {
        await this.documentVersionModel.updateOne(
          { _id: version._id, tenantId },
          { $addToSet: { reducedFidelityReasons: { $each: [...xlsx.reducedFidelityReasons] } } },
        );
      }
    } else {
      const prose = await this.buildProseCandidates(
        version._id,
        parsed.elements,
        tenantId,
        context,
        abortSignal,
      );
      candidates = prose.candidates;
      skippedChunkCount = prose.skippedChunkCount;
    }

    if (candidates.length === 0) {
      this.logger.debug(`Document version '${documentVersionId}' produced no facts`);
      return { factsCreated: 0, alreadyExtracted: false, skippedChunkCount, factKeys: [] };
    }

    // Every slug this extraction pass can legally mint a fact under: the tenant's matchable
    // measures (confirmed and proposed) plus whatever `proposeMany` just stamped for a header
    // proposal this same document minted. A candidate whose slug resolves to neither is dropped
    // below rather than persisted — see that loop's own comment for why.
    const stampBySlug = new Map<string, MeasureStamp>();
    for (const definition of context.matchable) {
      if (definition.status === 'rejected') {
        continue;
      }
      stampBySlug.set(definition.id, {
        measureId: new Types.ObjectId(definition.measureId),
        measureVersion: definition.version,
        measureStatus: definition.status,
      });
    }
    for (const [slug, stamp] of proposalStamps) {
      stampBySlug.set(slug, stamp);
    }

    const stampedCandidates: (CanonicalizedCandidate & { readonly stamp: MeasureStamp })[] = [];
    for (const candidate of candidates) {
      const stamp = stampBySlug.get(candidate.factKey.metric);
      if (!stamp) {
        // Fails CLOSED: a slug with no stamp names no measure the tenant currently holds (a race
        // between `loadExtractionContext` and a since-rejected proposal, most plausibly), and
        // persisting the fact anyway would mint a value invisible to every consumer that filters
        // on `measureStatus` while still occupying the ledger.
        this.logger.warn(
          `Dropping fact candidate for document version '${documentVersionId}': no measure stamp for slug '${candidate.factKey.metric}'`,
        );
        continue;
      }
      stampedCandidates.push({ ...candidate, stamp });
    }

    if (stampedCandidates.length === 0) {
      this.logger.debug(`Document version '${documentVersionId}' produced no stampable facts`);
      return { factsCreated: 0, alreadyExtracted: false, skippedChunkCount, factKeys: [] };
    }

    try {
      await this.extractedFactModel.insertMany(
        stampedCandidates.map((candidate) => {
          const period = parsePeriodKey(candidate.factKey.period);
          return {
            factKey: candidate.factKey,
            groupKeyNormalized: groupKey(candidate.factKey),
            value: candidate.value,
            rawText: candidate.rawText,
            confidence: candidate.confidence,
            extractionMethod: candidate.extractionMethod,
            packId: ACTIVE_PACK_ID,
            packVersion: ACTIVE_PACK_VERSION,
            measureId: candidate.stamp.measureId,
            measureVersion: candidate.stamp.measureVersion,
            measureStatus: candidate.stamp.measureStatus,
            ...(period.range
              ? {
                  periodStart: new Date(`${period.range.start}T00:00:00.000Z`),
                  periodEnd: new Date(`${period.range.end}T00:00:00.000Z`),
                }
              : {}),
            chunkId: candidate.chunkId,
            documentVersionId: version._id,
            locator: candidate.locator,
            tenantId: version.tenantId,
            observedAt: candidate.observedAt,
            entityMatched: candidate.entityMatched,
          };
        }),
      );
    } catch (error) {
      await this.extractedFactModel.deleteMany({ documentVersionId: version._id, tenantId });
      throw error;
    }

    this.logger.debug(
      `Document version '${documentVersionId}' produced ${stampedCandidates.length} facts`,
    );

    return {
      factsCreated: stampedCandidates.length,
      alreadyExtracted: false,
      skippedChunkCount,
      factKeys: stampedCandidates.map((candidate) => candidate.factKey),
    };
  }

  /**
   * Files the parenthetical alias definitions this version's own text states — `Northgate Business
   * Park (the "Property")` — against the tenant's registry, each with the quote and locator it was
   * read from.
   *
   * Runs on every version, spreadsheet or prose, and costs no inference:
   * `harvestParentheticalAliases` is a pure function over already-parsed text, so this path makes
   * no model call regardless of what the document contains.
   *
   * Fails OPEN. A registry write that throws is logged and swallowed, because harvesting enriches
   * the registry while the method it runs inside exists to extract facts — losing an alias costs a
   * name that stays unresolved, losing the facts costs the document. `EXTRACTION_ALIAS_HARVEST_
   * AUTO_APPLY` decides whether what is recorded resolves or only sits as a proposal; it is off by
   * default, so this call changes no grouping until an operator enables it.
   */
  private async harvestAliases(
    elements: readonly ParsedElement[],
    versionId: Types.ObjectId,
    tenantId: string,
  ): Promise<void> {
    try {
      const recorded = await this.canonicalEntityService.recordHarvestedAliases(
        harvestParentheticalAliases(elements),
        tenantId,
        versionId,
        this.config.extraction.aliasHarvestAutoApply,
      );
      this.logger.debug(
        `Document version '${versionId.toString()}' contributed ${recorded} harvested alias(es) to the registry`,
      );
    } catch (error) {
      this.logger.warn(
        `Alias harvesting failed for document version '${versionId.toString()}': ${String(error)}`,
      );
    }
  }

  /**
   * Resolves every candidate's `factKey.entity` against the tenant's `CanonicalEntity` registry
   * and swaps in the canonical name wherever one matches — before `insertMany` and before
   * `groupKey()` computes `groupKeyNormalized`, so two facts naming the same entity under
   * different registered spellings land in the same conflict-detection group instead of two
   * invisible singletons. A single batched lookup (`CanonicalEntityService.resolveMany`) covers
   * every candidate regardless of how many facts this document produced. An unmatched name is
   * never dropped or guessed at: `factKey.entity` stays exactly as extracted and `entityMatched`
   * records the miss so a human can find the registry's gap later.
   *
   * The spreadsheet path's resolution step. The prose path resolves through the same service
   * inside `extractProseFacts`, one chunk at a time, because agreement between that chunk's
   * extraction passes is keyed on the resolved entity name and so cannot wait until here.
   */
  private async canonicalizeCandidateEntities<T extends { factKey: FactKey }>(
    candidates: readonly T[],
    tenantId: string,
  ): Promise<(T & { entityMatched: boolean })[]> {
    const resolutions = await this.canonicalEntityService.resolveMany(
      candidates.map((candidate) => candidate.factKey.entity),
      tenantId,
    );

    return candidates.map((candidate, index) => {
      const resolution = resolutions[index];
      return {
        ...candidate,
        factKey: { ...candidate.factKey, entity: resolution.name },
        entityMatched: resolution.matched,
      };
    });
  }

  /**
   * Cell-level facts among a request's retrieved evidence, scoped to `chunkIds` and `tenantId` so
   * a request can only ever draw on facts extracted from chunks it actually retrieved — never the
   * tenant's whole `extracted_facts` collection. Only `xlsx-cell` locators qualify: check 4 in
   * `verifyClaim` only ever upgrades a citation using a fact narrower than the chunk it was
   * extracted from, and `xlsx-region`/`pdf-page`/`docx-paragraph` facts carry no narrower position
   * to upgrade to. Returns the raw documents, not `GroundingCellFact` — the caller (`activities.ts`,
   * DB-aware) projects them, per `GroundingCellFact`'s own doc comment in `verify-claim.ts`.
   *
   * `measureStatus: 'confirmed'` excludes a fact extracted under a measure no admin has confirmed
   * yet: it is stored, but must not upgrade a citation or otherwise reach a request until a human
   * has vouched for the measure it is stamped under.
   */
  async findCellFacts(
    chunkIds: readonly string[],
    tenantId: string,
  ): Promise<ExtractedFactDocument[]> {
    if (chunkIds.length === 0) {
      return [];
    }

    return this.extractedFactModel.find({
      chunkId: { $in: [...chunkIds] },
      tenantId,
      'locator.kind': 'xlsx-cell',
      measureStatus: 'confirmed',
    });
  }

  /**
   * Every fact extracted from `chunkIds`, regardless of locator kind — unlike {@link findCellFacts},
   * which is `xlsx-cell`-only because it exists to find a fact narrower than its chunk for citation
   * upgrade. A prose fact (`pdf-page`, `docx-paragraph`, `xlsx-region`) carries no narrower locator
   * to upgrade to, but still carries a value worth comparing against an open conflict —
   * `ClaimVerificationService` is this method's caller, for exactly that comparison. Scoped to
   * `chunkIds` and `tenantId` for the same reason `findCellFacts` is: a request can only ever draw
   * on facts extracted from chunks it actually retrieved.
   *
   * `measureStatus: 'confirmed'` excludes a fact extracted under a measure no admin has confirmed
   * yet, the same exclusion {@link findCellFacts} applies and for the same reason: a proposed
   * measure's facts must stay invisible to a conflict comparison until a human vouches for it.
   */
  async findFactsForChunks(
    chunkIds: readonly string[],
    tenantId: string,
  ): Promise<ExtractedFactDocument[]> {
    if (chunkIds.length === 0) {
      return [];
    }

    return this.extractedFactModel.find({
      chunkId: { $in: [...chunkIds] },
      tenantId,
      measureStatus: 'confirmed',
    });
  }

  private async buildXlsxCandidates(
    versionId: Types.ObjectId,
    elements: readonly ParsedElement[],
    tenantId: string,
    context: ExtractionMeasureContext,
  ): Promise<{
    readonly candidates: (FactCandidate & { chunkId: string })[];
    readonly reducedFidelityReasons: readonly string[];
    readonly proposalStamps: Map<string, MeasureStamp>;
  }> {
    const chunks = await this.evidenceChunkModel.find({ documentVersionId: versionId, tenantId });
    if (chunks.length === 0) {
      throw new InternalServerErrorException(
        `Document version '${versionId.toString()}' has no ingested chunks — run ingestion before fact extraction`,
      );
    }

    // `extractXlsxFacts`'s own `reducedFidelityReasons` already folds in both header ambiguity and
    // any `rejected` candidate (a parsed unit its metric doesn't declare, or — with
    // `strictPercentUnitResolution` — a percent-vs-ratio cell it refused to guess at) — this method
    // only has to pass the array through to its own caller.
    const { accepted, reducedFidelityReasons, proposals } = extractXlsxFacts(elements, {
      matchable: context.matchable,
      rejectedSlugs: context.rejectedSlugs,
      proposeFromHeaders: this.config.extraction.headerProposals,
    });

    // Files every unmatched column's proposal against the tenant's measure registry and folds its
    // candidates in alongside the extractor's directly-matched ones — a candidate whose slug ends
    // up with no stamp (an unlikely race, or a proposal `proposeMany` could not resolve) is dropped
    // later, uniformly, by the caller's stamping pass rather than here.
    const proposalStamps =
      proposals.length > 0
        ? await this.measuresService.proposeMany(
            tenantId,
            versionId,
            proposals.map((entry) => entry.proposal),
          )
        : new Map<string, MeasureStamp>();
    const allAccepted =
      proposals.length > 0
        ? [...accepted, ...proposals.flatMap((entry) => entry.candidates)]
        : accepted;

    const candidates: (FactCandidate & { chunkId: string })[] = [];
    for (const candidate of allAccepted) {
      const cellLocator = candidate.locator as XlsxCellLocator;
      const containingChunk = findXlsxRegionChunk(
        chunks,
        cellLocator.sheetName,
        parseRowFromCellAddress(cellLocator.cell),
      );
      if (!containingChunk) {
        // A cell whose ingested chunk cannot be found (chunking output changed between ingestion
        // and extraction, or ingestion only partially completed) contributes no fact rather than
        // one with a fabricated chunk reference — a measurement gap here should not block every
        // other cell's fact.
        this.logger.debug(
          `No ingested chunk contains cell '${cellLocator.sheetName}!${cellLocator.cell}'; dropping candidate`,
        );
        continue;
      }
      candidates.push({ ...candidate, chunkId: containingChunk._id });
    }
    return { candidates, reducedFidelityReasons, proposalStamps };
  }

  private async buildProseCandidates(
    versionId: Types.ObjectId,
    elements: readonly ParsedElement[],
    tenantId: string,
    context: ExtractionMeasureContext,
    abortSignal?: AbortSignal,
  ): Promise<{
    readonly candidates: CanonicalizedCandidate[];
    readonly skippedChunkCount: number;
  }> {
    const chunks = await this.evidenceChunkModel.find({ documentVersionId: versionId, tenantId });
    if (chunks.length === 0) {
      throw new InternalServerErrorException(
        `Document version '${versionId.toString()}' has no ingested chunks — run ingestion before fact extraction`,
      );
    }

    /**
     * `mapWithConcurrency` writes each chunk's extraction result to the slot matching that
     * chunk's own index, independent of which chunk's passes settle first — so zipping `chunks`
     * back against `results` by index below is safe, and every candidate's `factKey`/`chunkId`
     * stays tied to the chunk it was extracted from regardless of extraction order.
     */
    const results = await mapWithConcurrency<EvidenceChunkDocument, ProseFactExtractionResult>(
      chunks,
      this.config.extraction.chunkConcurrency,
      (chunk) => {
        // Checked before every chunk's model call, not only once up front: `mapWithConcurrency`
        // starts new calls as earlier ones settle, so an abort mid-run must still stop calls that
        // have not started yet, not only the ones already in flight when it fires.
        abortSignal?.throwIfAborted();
        return extractProseFacts({
          chunkText: chunk.text,
          chunkLocator: chunk.locator,
          sourceElements: elements,
          modelProvider: this.modelProvider,
          ontology: context.confirmed,
          tenantId,
          resolveEntities: (rawNames) =>
            this.canonicalEntityService.resolveMany(rawNames, tenantId),
        });
      },
    );

    const candidates: CanonicalizedCandidate[] = [];
    let skippedChunkCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const { accepted, rejected, successfulPassCount, skippedForInsufficientPasses, agreement } =
        results[i];

      if (skippedForInsufficientPasses) {
        // Fewer than 2 of the 3 extraction passes returned usable output — majority agreement
        // was structurally impossible, so this chunk contributes no facts at all rather than
        // one pass's unconfirmed guess. Mirrors `ConflictsService.scanForConflicts`'s per-skip
        // `warn` for the same "visible, not silent" reason.
        skippedChunkCount += 1;
        this.logger.warn(
          `Chunk '${chunk._id.toString()}' had only ${successfulPassCount} of 3 successful extraction passes; skipping (need >= 2 for agreement)`,
        );
        continue;
      }

      for (const rejection of rejected) {
        this.logger.debug(
          `Dropped fact candidate for chunk '${chunk._id.toString()}': ${rejection.reason}`,
        );
      }

      // The prose pipeline's fact-loss counter, and the only place it is observable: a group the
      // passes proposed but could not agree on leaves no fact and no other trace. Reported per
      // group at `warn`, like the whole-chunk skip above, because a document producing these
      // steadily is a document whose facts are being silently lost. Logged only past the skip
      // branch — when the chunk was skipped outright, every group is dropped by definition and
      // repeating them here would say nothing the skip warn does not.
      for (const dropped of agreement.droppedGroups) {
        this.logger.warn(
          `Chunk '${chunk._id.toString()}' dropped fact group '${groupKey(dropped.factKey)}': ${dropped.agreeingPasses} of ${dropped.totalPasses} passes agreed`,
        );
      }
      candidates.push(...accepted.map((fact) => ({ ...fact, chunkId: chunk._id })));
    }
    return { candidates, skippedChunkCount };
  }
}
