import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import type {
  DocumentDocument,
  DocumentSourceClass,
} from '../../../database/schemas/evidence/document/document.schema';
import type { DocumentVersionDocument } from '../../../database/schemas/evidence/document-version/document-version.schema';
import type { ExtractedFactDocument } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';

/**
 * Batch-resolves each fact's document `sourceClass` via its `documentVersionId` — two `$in`
 * queries total (`DocumentVersion` then `Document`), never one per fact, so a batch of conflicts
 * costs the same two extra round-trips regardless of how many facts it touches. Every query is
 * scoped to `tenantId` explicitly, not left to `tenantScopePlugin`'s ALS backstop alone: this
 * feeds a proposal shown to a human or scored against one, the same reasoning `ConflictsService`'s
 * own explicit-tenantId queries document.
 *
 * Fails OPEN to `'unclassified'` when a fact's `documentVersionId` or that version's `documentId`
 * no longer resolves — this is survivorship-policy enrichment, not a factIds/values integrity
 * check; a fact's document missing is exactly what `'unclassified'` already means
 * (`Document.sourceClass`'s own doc comment: "no authority information"), not a data-integrity
 * fault worth aborting the read for.
 *
 * Shared by `ConflictsService` (`list`, `computeProposalForConflict`) and
 * `ResolutionBacktestService`, both of which need this exact enrichment to feed
 * `resolveConflictPolicy`.
 */
export async function loadSourceClassByFactId(
  documentVersionModel: Model<DocumentVersionDocument>,
  documentModel: Model<DocumentDocument>,
  facts: readonly Pick<ExtractedFactDocument, '_id' | 'documentVersionId'>[],
  tenantId: string,
): Promise<Map<string, DocumentSourceClass>> {
  if (facts.length === 0) {
    return new Map();
  }

  const versionIds = [...new Set(facts.map((fact) => fact.documentVersionId.toString()))].map(
    (id) => new Types.ObjectId(id),
  );
  const versions = await documentVersionModel.find(
    { _id: { $in: versionIds }, tenantId },
    { documentId: 1 },
  );
  const documentIdByVersionId = new Map(
    versions.map((version) => [version._id.toString(), version.documentId.toString()]),
  );

  const documentIds = [...new Set(versions.map((version) => version.documentId.toString()))].map(
    (id) => new Types.ObjectId(id),
  );
  const documents =
    documentIds.length === 0
      ? []
      : await documentModel.find({ _id: { $in: documentIds }, tenantId }, { sourceClass: 1 });
  const sourceClassByDocumentId = new Map(
    documents.map((document) => [document._id.toString(), document.sourceClass]),
  );

  const sourceClassByFactId = new Map<string, DocumentSourceClass>();
  for (const fact of facts) {
    const documentId = documentIdByVersionId.get(fact.documentVersionId.toString());
    const sourceClass = documentId ? sourceClassByDocumentId.get(documentId) : undefined;
    sourceClassByFactId.set(fact._id.toString(), sourceClass ?? 'unclassified');
  }
  return sourceClassByFactId;
}
