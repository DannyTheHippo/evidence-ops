import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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
import { ParserRegistry } from '../ingestion/parser.registry';
import type { ParsedElement } from '../ingestion/parsers/parsed-element.type';
import { DocumentVersionNotFoundException } from './exceptions/facts.exception';
import { METRIC_ONTOLOGY } from './metric-ontology';
import { extractProseFacts } from './prose-fact-extractor';
import { findXlsxRegionChunk, parseRowFromCellAddress } from './resolve-xlsx-fact-chunk';
import { extractXlsxFacts, type FactCandidate } from './xlsx-fact-extractor';

export interface FactsExtractionResult {
  readonly factsCreated: number;
  /** True when this call was a no-op because the version was already extracted. */
  readonly alreadyExtracted: boolean;
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

    const existingFactCount = await this.extractedFactModel.countDocuments({
      documentVersionId: version._id,
    });
    if (existingFactCount > 0) {
      this.logger.debug(
        `Document version '${documentVersionId}' already has ${existingFactCount} facts; skipping`,
      );
      return { factsCreated: 0, alreadyExtracted: true };
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
    const candidates = isSpreadsheet
      ? await this.buildXlsxCandidates(version._id, parsed.elements)
      : await this.buildProseCandidates(version._id, parsed.elements);

    if (candidates.length === 0) {
      this.logger.debug(`Document version '${documentVersionId}' produced no facts`);
      return { factsCreated: 0, alreadyExtracted: false };
    }

    try {
      await this.extractedFactModel.insertMany(
        candidates.map((candidate) => ({
          factKey: candidate.factKey,
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

    return { factsCreated: candidates.length, alreadyExtracted: false };
  }

  private async buildXlsxCandidates(
    versionId: Types.ObjectId,
    elements: readonly ParsedElement[],
  ): Promise<(FactCandidate & { chunkId: Types.ObjectId })[]> {
    const chunks = await this.evidenceChunkModel.find({ documentVersionId: versionId });
    if (chunks.length === 0) {
      throw new InternalServerErrorException(
        `Document version '${versionId.toString()}' has no ingested chunks — run ingestion before fact extraction`,
      );
    }

    const candidates: (FactCandidate & { chunkId: Types.ObjectId })[] = [];
    for (const candidate of extractXlsxFacts(elements, METRIC_ONTOLOGY)) {
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
  ): Promise<(FactCandidate & { chunkId: Types.ObjectId })[]> {
    const chunks = await this.evidenceChunkModel.find({ documentVersionId: versionId });
    if (chunks.length === 0) {
      throw new InternalServerErrorException(
        `Document version '${versionId.toString()}' has no ingested chunks — run ingestion before fact extraction`,
      );
    }

    const candidates: (FactCandidate & { chunkId: Types.ObjectId })[] = [];
    for (const chunk of chunks) {
      const { accepted, rejected } = await extractProseFacts({
        chunkText: chunk.text,
        chunkLocator: chunk.locator,
        sourceElements: elements,
        modelProvider: this.modelProvider,
        ontology: METRIC_ONTOLOGY,
      });
      for (const rejection of rejected) {
        this.logger.debug(
          `Dropped fact candidate for chunk '${chunk._id.toString()}': ${rejection.reason}`,
        );
      }
      candidates.push(...accepted.map((fact) => ({ ...fact, chunkId: chunk._id })));
    }
    return candidates;
  }
}
