import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import type { DocumentDocument } from '../../../database/schemas/evidence/document/document.schema';
import type { DocumentVersionDocument } from '../../../database/schemas/evidence/document-version/document-version.schema';
import type { ExtractedFactDocument } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';

/** One fact's provenance state, as read off its `DocumentVersion` and that version's `Document` —
 * `sha256` is what a citation pins, and a caller must never emit a citation it cannot check, so a
 * fact whose lifecycle cannot be resolved (see `loadFactLifecycle`'s own comment) carries no
 * `FactLifecycle` at all rather than one with a placeholder `sha256`. */
export interface FactLifecycle {
  readonly withdrawn: boolean;
  readonly superseded: boolean;
  readonly sha256: string;
  readonly documentId: string;
}

/**
 * Batch-resolves every fact's lifecycle in exactly two queries regardless of how many facts are
 * passed — one `$in` over the distinct `documentVersionId`s, one `$in` over the distinct
 * `documentId`s those versions carry — mirroring `loadFactSourceEnrichment`'s batching
 * (`load-source-class-by-fact-id.ts`). `superseded` is true when the fact's document has a
 * `currentVersionId` that differs from the fact's own version — a live document has moved on to a
 * newer upload since this fact was extracted.
 *
 * A fact whose `documentVersionId` does not resolve to a `DocumentVersion` row (in this tenant) maps
 * to `undefined` rather than a best-effort guess: `resolveCell` and citation building both key off
 * `sha256`, and a citation without a checkable `sha256` must never be emitted, so the caller is
 * expected to exclude an `undefined` entry from both resolution and citations (and to log it — this
 * should not happen for a fact whose version existed at extraction time, so a caller seeing one is
 * evidence worth surfacing, not silently dropping). A version whose own `documentId` fails to
 * resolve to a `Document` row is treated as not-superseded (`superseded: false`) rather than
 * `undefined` — the version itself, and therefore its `sha256`, is still known and citable; only the
 * supersession signal is unavailable.
 */
export async function loadFactLifecycle(
  documentVersionModel: Model<DocumentVersionDocument>,
  documentModel: Model<DocumentDocument>,
  facts: readonly Pick<ExtractedFactDocument, '_id' | 'documentVersionId'>[],
  tenantId: string,
): Promise<Map<string, FactLifecycle | undefined>> {
  if (facts.length === 0) {
    return new Map();
  }

  const versionIds = [...new Set(facts.map((fact) => fact.documentVersionId.toString()))].map(
    (id) => new Types.ObjectId(id),
  );
  const versions = await documentVersionModel.find(
    { _id: { $in: versionIds }, tenantId },
    { documentId: 1, sha256: 1, withdrawnAt: 1 },
  );
  const versionById = new Map(versions.map((version) => [version._id.toString(), version]));

  const documentIds = [...new Set(versions.map((version) => version.documentId.toString()))].map(
    (id) => new Types.ObjectId(id),
  );
  const documents =
    documentIds.length === 0
      ? []
      : await documentModel.find({ _id: { $in: documentIds }, tenantId }, { currentVersionId: 1 });
  const documentById = new Map(documents.map((document) => [document._id.toString(), document]));

  const lifecycleByFactId = new Map<string, FactLifecycle | undefined>();
  for (const fact of facts) {
    const version = versionById.get(fact.documentVersionId.toString());
    if (!version) {
      lifecycleByFactId.set(fact._id.toString(), undefined);
      continue;
    }
    const documentId = version.documentId.toString();
    const document = documentById.get(documentId);
    const currentVersionId = document?.currentVersionId;
    lifecycleByFactId.set(fact._id.toString(), {
      withdrawn: Boolean(version.withdrawnAt),
      superseded: currentVersionId !== undefined && !currentVersionId.equals(version._id),
      sha256: version.sha256,
      documentId,
    });
  }
  return lifecycleByFactId;
}
