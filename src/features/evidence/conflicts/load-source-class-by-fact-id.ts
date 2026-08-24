import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import type {
  DocumentDocument,
  DocumentSourceClass,
} from '../../../database/schemas/evidence/document/document.schema';
import type { DocumentVersionDocument } from '../../../database/schemas/evidence/document-version/document-version.schema';
import type { ExtractedFactDocument } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';

/** One fact's provenance enrichment: its document's authority classification, and whether the
 *  version it came from currently carries `withdrawnAt`. */
export interface FactSourceEnrichment {
  readonly sourceClass: DocumentSourceClass;
  readonly withdrawn: boolean;
}

/**
 * Batch-resolves each fact's document `sourceClass` AND whether its `documentVersionId` currently
 * carries `withdrawnAt` — two `$in` queries total (`DocumentVersion` then `Document`), never one
 * per fact, so a batch of conflicts costs the same two extra round-trips regardless of how many
 * facts it touches or which of the two signals a caller needs. `withdrawnAt` comes off the same
 * `DocumentVersion` rows the `sourceClass` join already reads, so a caller needing both never pays
 * a third query for the second signal. Every query is scoped to `tenantId` explicitly, not left to
 * `tenantScopePlugin`'s ALS backstop alone: this feeds a proposal shown to a human or scored
 * against one, the same reasoning `ConflictsService`'s own explicit-tenantId queries document.
 *
 * Fails OPEN to `{ sourceClass: 'unclassified', withdrawn: false }` when a fact's
 * `documentVersionId` or that version's `documentId` no longer resolves — this is
 * survivorship-policy enrichment, not a factIds/values integrity check; a fact's document missing
 * is exactly what `'unclassified'` already means (`Document.sourceClass`'s own doc comment: "no
 * authority information"), not a data-integrity fault worth aborting the read for, and a version
 * that cannot be found gives no evidence of withdrawal either.
 *
 * `loadSourceClassByFactId` below is a thin sourceClass-only projection of this function, kept for
 * `ResolutionBacktestService.run` and `ConflictsService.computeProposalForConflict` — neither of
 * which needs withdrawal state — so their existing `Map<string, DocumentSourceClass>` shape never
 * has to change.
 */
export async function loadFactSourceEnrichment(
  documentVersionModel: Model<DocumentVersionDocument>,
  documentModel: Model<DocumentDocument>,
  facts: readonly Pick<ExtractedFactDocument, '_id' | 'documentVersionId'>[],
  tenantId: string,
): Promise<Map<string, FactSourceEnrichment>> {
  if (facts.length === 0) {
    return new Map();
  }

  const versionIds = [...new Set(facts.map((fact) => fact.documentVersionId.toString()))].map(
    (id) => new Types.ObjectId(id),
  );
  const versions = await documentVersionModel.find(
    { _id: { $in: versionIds }, tenantId },
    { documentId: 1, withdrawnAt: 1 },
  );
  const documentIdByVersionId = new Map(
    versions.map((version) => [version._id.toString(), version.documentId.toString()]),
  );
  const withdrawnByVersionId = new Map(
    versions.map((version) => [version._id.toString(), Boolean(version.withdrawnAt)]),
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

  const enrichmentByFactId = new Map<string, FactSourceEnrichment>();
  for (const fact of facts) {
    const versionId = fact.documentVersionId.toString();
    const documentId = documentIdByVersionId.get(versionId);
    const sourceClass = documentId ? sourceClassByDocumentId.get(documentId) : undefined;
    enrichmentByFactId.set(fact._id.toString(), {
      sourceClass: sourceClass ?? 'unclassified',
      withdrawn: withdrawnByVersionId.get(versionId) ?? false,
    });
  }
  return enrichmentByFactId;
}

/**
 * Shared by `ConflictsService.computeProposalForConflict` and `ResolutionBacktestService.run`,
 * both of which need only `sourceClass` to feed `resolveConflictPolicy`. Calls
 * `loadFactSourceEnrichment` once and re-maps its result in memory — no second query — so this
 * keeps its original `Map<string, DocumentSourceClass>` shape for callers that predate, and never
 * need, the withdrawal signal `loadFactSourceEnrichment` also carries.
 */
export async function loadSourceClassByFactId(
  documentVersionModel: Model<DocumentVersionDocument>,
  documentModel: Model<DocumentDocument>,
  facts: readonly Pick<ExtractedFactDocument, '_id' | 'documentVersionId'>[],
  tenantId: string,
): Promise<Map<string, DocumentSourceClass>> {
  const enrichmentByFactId = await loadFactSourceEnrichment(
    documentVersionModel,
    documentModel,
    facts,
    tenantId,
  );
  return new Map(
    [...enrichmentByFactId].map(([factId, enrichment]) => [factId, enrichment.sourceClass]),
  );
}
