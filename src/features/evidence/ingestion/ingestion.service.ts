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
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../../../providers/embedding/embedding-provider.interface';
import {
  DOCUMENT_STORE,
  type DocumentStore,
} from '../../../providers/storage/document-store.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { chunkElements } from './chunker';
import { DocumentVersionNotFoundException } from './exceptions/ingestion.exception';
import { ParserRegistry } from './parser.registry';

export interface IngestionResult {
  readonly chunksCreated: number;
  /** True when this call was a no-op because the version was already ingested. */
  readonly alreadyIngested: boolean;
}

@Injectable()
export class IngestionService {
  constructor(
    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(EvidenceChunk.name)
    private readonly evidenceChunkModel: Model<EvidenceChunkDocument>,

    @Inject(DOCUMENT_STORE)
    private readonly documentStore: DocumentStore,

    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProvider: EmbeddingProvider,

    private readonly parserRegistry: ParserRegistry,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(IngestionService.name);
  }

  /**
   * Loads a version's bytes, parses, chunks, embeds, and persists `EvidenceChunk` documents.
   *
   * Idempotent by a simple existence check rather than a delete-and-replace: a version's bytes
   * never change once created (a re-upload of different bytes is a new version — see
   * `DocumentsService.addVersion`), so any chunk already stamped with this `documentVersionId` is
   * still correct, and skipping avoids paying for re-embedding on every retry.
   *
   * A failed `insertMany` is rolled back below, because the existence check would otherwise turn a
   * transient write error into permanent half-ingestion — the version would look ingested forever
   * while serving a partial evidence set, which is silently wrong rather than loudly broken.
   *
   * Residual gap, deliberately not engineered around here: a process crash *between* the partial
   * insert and the rollback leaves the same partial state. Closing that needs an explicit
   * completion marker on `DocumentVersion` rather than inferring completion from chunk count —
   * a schema change, tracked separately.
   */
  async ingestVersion(documentVersionId: string): Promise<IngestionResult> {
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

    const existingChunkCount = await this.evidenceChunkModel.countDocuments({
      documentVersionId: version._id,
    });
    if (existingChunkCount > 0) {
      this.logger.debug(
        `Document version '${documentVersionId}' already has ${existingChunkCount} chunks; skipping`,
      );
      return { chunksCreated: 0, alreadyIngested: true };
    }

    const stored = await this.documentStore.get(version.storageKey);
    if (!stored) {
      // Data-integrity fault, not a normal input-validation branch: `storageKey` is only ever set
      // from a successful `documentStore.put()` (see `DocumentsService`), so a miss here means the
      // store lost bytes it already confirmed writing — mirrors `DocumentsService
      // .assertCurrentVersion`'s use of a bare `InternalServerErrorException` for the same class
      // of impossible state.
      throw new InternalServerErrorException(
        `Document version '${documentVersionId}' has no resolvable content in the document store`,
      );
    }

    const parser = this.parserRegistry.resolve(stored.contentType);
    const parsed = await parser.parse(stored.content);
    const chunks = chunkElements(parsed.elements);

    if (chunks.length === 0) {
      this.logger.debug(`Document version '${documentVersionId}' produced no chunks`);
      return { chunksCreated: 0, alreadyIngested: false };
    }

    const embeddingResult = await this.embeddingProvider.embed({
      inputs: chunks.map((chunk) => chunk.text),
      inputType: 'document',
    });

    try {
      await this.evidenceChunkModel.insertMany(
        chunks.map((chunk, index) => ({
          documentId: version.documentId,
          documentVersionId: version._id,
          text: chunk.text,
          tokenCount: chunk.tokenCount,
          embedding: embeddingResult.embeddings[index],
          locator: chunk.locator,
          tenantId: version.tenantId,
        })),
      );
    } catch (error) {
      await this.evidenceChunkModel.deleteMany({ documentVersionId: version._id });
      throw error;
    }

    this.logger.debug(
      `Document version '${documentVersionId}' ingested into ${chunks.length} chunks`,
    );

    return { chunksCreated: chunks.length, alreadyIngested: false };
  }
}
