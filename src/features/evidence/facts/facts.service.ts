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
import { DocumentVersionNotFoundException } from './exceptions/facts.exception';
import { METRIC_ONTOLOGY } from './metric-ontology';
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

    private readonly config: TypedConfigService,

    private readonly logger: AppLogger,
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
   */
  async extractFacts(documentVersionId: string): Promise<FactsExtractionResult> {
    if (!Types.ObjectId.isValid(documentVersionId)) {
      throw new DocumentVersionNotFoundException(
        `Document version '${documentVersionId}' not found`,
      );
    }

    const version = await this.documentVersionModel.findById(documentVersionId);
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

    const isSpreadsheet = parsed.elements[0]?.locator.kind === 'xlsx-cell';
    let candidates: (FactCandidate & { chunkId: string })[];
    let skippedChunkCount = 0;
    if (isSpreadsheet) {
      candidates = await this.buildXlsxCandidates(version._id, parsed.elements);
    } else {
      const prose = await this.buildProseCandidates(version._id, parsed.elements);
      candidates = prose.candidates;
      skippedChunkCount = prose.skippedChunkCount;
    }

    if (candidates.length === 0) {
      this.logger.debug(`Document version '${documentVersionId}' produced no facts`);
      return { factsCreated: 0, alreadyExtracted: false, skippedChunkCount, factKeys: [] };
    }

    try {
      await this.extractedFactModel.insertMany(
        candidates.map((candidate) => ({
          factKey: candidate.factKey,
          groupKeyNormalized: groupKey(candidate.factKey),
          value: candidate.value,
          rawText: candidate.rawText,
          confidence: candidate.confidence,
          extractionMethod: candidate.extractionMethod,
          chunkId: candidate.chunkId,
          documentVersionId: version._id,
          locator: candidate.locator,
          tenantId: version.tenantId,
        })),
      );
    } catch (error) {
      await this.extractedFactModel.deleteMany({ documentVersionId: version._id });
      throw error;
    }

    this.logger.debug(
      `Document version '${documentVersionId}' produced ${candidates.length} facts`,
    );

    return {
      factsCreated: candidates.length,
      alreadyExtracted: false,
      skippedChunkCount,
      factKeys: candidates.map((candidate) => candidate.factKey),
    };
  }

  /**
   * Cell-level facts among a request's retrieved evidence, scoped to `chunkIds` and `tenantId` so
   * a request can only ever draw on facts extracted from chunks it actually retrieved — never the
   * tenant's whole `extracted_facts` collection. Only `xlsx-cell` locators qualify: check 3 in
   * `verifyClaim` only ever upgrades a citation using a fact narrower than the chunk it was
   * extracted from, and `xlsx-region`/`pdf-page`/`docx-paragraph` facts carry no narrower position
   * to upgrade to. Returns the raw documents, not `GroundingCellFact` — the caller (`activities.ts`,
   * DB-aware) projects them, per `GroundingCellFact`'s own doc comment in `verify-claim.ts`.
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
    });
  }

  private async buildXlsxCandidates(
    versionId: Types.ObjectId,
    elements: readonly ParsedElement[],
  ): Promise<(FactCandidate & { chunkId: string })[]> {
    const chunks = await this.evidenceChunkModel.find({ documentVersionId: versionId });
    if (chunks.length === 0) {
      throw new InternalServerErrorException(
        `Document version '${versionId.toString()}' has no ingested chunks — run ingestion before fact extraction`,
      );
    }

    // `extractXlsxFacts`'s `rejected` list (a candidate whose parsed unit isn't declared by its
    // own metric) is not consumed here: with today's ontology every display parser only ever
    // emits a unit its metric declares (see xlsx-fact-extractor.ts's own doc comments), so
    // `rejected` is always empty for real input — a log statement gated on it would be dead code
    // in this 100%-coverage-gated file. `extractXlsxFacts`'s own test suite (a synthetic,
    // deliberately misconfigured ontology) is where that branch is exercised.
    const { accepted } = extractXlsxFacts(elements, METRIC_ONTOLOGY);

    const candidates: (FactCandidate & { chunkId: string })[] = [];
    for (const candidate of accepted) {
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
    return candidates;
  }

  private async buildProseCandidates(
    versionId: Types.ObjectId,
    elements: readonly ParsedElement[],
  ): Promise<{
    readonly candidates: (FactCandidate & { chunkId: string })[];
    readonly skippedChunkCount: number;
  }> {
    const chunks = await this.evidenceChunkModel.find({ documentVersionId: versionId });
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
      (chunk) =>
        extractProseFacts({
          chunkText: chunk.text,
          chunkLocator: chunk.locator,
          sourceElements: elements,
          modelProvider: this.modelProvider,
          ontology: METRIC_ONTOLOGY,
        }),
    );

    const candidates: (FactCandidate & { chunkId: string })[] = [];
    let skippedChunkCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const { accepted, rejected, successfulPassCount, skippedForInsufficientPasses } = results[i];

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
      candidates.push(...accepted.map((fact) => ({ ...fact, chunkId: chunk._id })));
    }
    return { candidates, skippedChunkCount };
  }
}
