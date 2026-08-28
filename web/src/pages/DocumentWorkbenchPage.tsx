import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  documentVersionContentUrl,
  fetchDocumentVersionContent,
  getDocumentById,
  type DocumentVersion,
  type DocumentVersionIngestionStatus,
  type DocumentWithVersions,
} from '../api/client';
import Badge, { type BadgeTone } from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import SplitView from '../components/ui/SplitView';
import Timestamp from '../components/ui/Timestamp';
import { IconDownload } from '../components/icons';
import { truncateSha256 } from '../lib/identifiers';
import { useObjectUrl } from '../lib/use-object-url';
import { formatBytes } from './data-room/format-size';
import EvidenceReader from './document-workbench/EvidenceReader';

// Mirrors VersionRow's own total map, for the same reason: a status the API union adds fails
// typecheck here instead of silently falling through a default branch. 'needs-ocr' and
// 'facts-failed' carry the same 'caution' tone as 'pending' — each still has real, citable
// content and only a known gap, never the verification-grade failure 'rejected' signals
// elsewhere in this app.
const INGESTION_TONE: Record<DocumentVersionIngestionStatus, BadgeTone> = {
  pending: 'caution',
  completed: 'verified',
  'facts-failed': 'caution',
  failed: 'rejected',
  'needs-ocr': 'caution',
};

function findVersion(doc: DocumentWithVersions, versionId: string): DocumentVersion | undefined {
  return doc.versions.find((version) => version.id === versionId);
}

export default function DocumentWorkbenchPage() {
  const { documentId, versionId } = useParams<{ documentId: string; versionId: string }>();
  const [doc, setDoc] = useState<DocumentWithVersions | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by the evidence reader once it resolves the `?chunk=` target to a `pdf-page` locator —
  // `null` otherwise, which leaves the iframe pointed at the document's default opening page.
  const [resolvedPage, setResolvedPage] = useState<number | null>(null);

  useEffect(() => {
    if (!documentId) return;
    getDocumentById(documentId)
      .then((result) => {
        setDoc(result);
        setNotFound(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load document');
      });
  }, [documentId]);

  const version = doc && versionId ? findVersion(doc, versionId) : undefined;
  const isPdf = doc?.sourceKind === 'pdf';

  // Only fetched once the version is known to be a PDF — the non-PDF pane never asks for the
  // bytes it has nothing to render inline yet.
  const { url: objectUrl, error: blobError } = useObjectUrl(
    isPdf && version ? version.id : null,
    fetchDocumentVersionContent,
  );

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence</span>
          <h1 className="page-title">{doc ? doc.title : 'Document'}</h1>
          <p className="page-sub">
            {version ? `Version ${version.versionNumber}` : 'Document workbench'}
          </p>
        </div>
        {documentId && (
          <Link to={`/documents/${documentId}`} className="btn btn--secondary btn--sm">
            Back to document
          </Link>
        )}
      </div>

      {(!documentId || !versionId) && (
        <p className="error error--page" role="alert">
          No document or version id provided.
        </p>
      )}

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {notFound && <p className="notice notice--info">Document not found.</p>}

      {!doc && !error && !notFound && documentId && <Skeleton label="Loading document…" />}

      {doc && !version && !notFound && (
        <p className="notice notice--info">This version does not belong to this document.</p>
      )}

      {doc && version && (
        <SplitView
          ratio="reader"
          primaryLabel="Document preview"
          secondaryLabel="Version details"
          primary={
            isPdf ? (
              <>
                {blobError && (
                  <p className="error" role="alert">
                    {blobError}
                  </p>
                )}
                {!blobError && !objectUrl && <Skeleton label="Loading document…" />}
                {!blobError && objectUrl && (
                  <iframe
                    title={`${doc.title}, version ${version.versionNumber}`}
                    src={resolvedPage ? `${objectUrl}#page=${resolvedPage}` : objectUrl}
                    className="workbench-frame"
                  />
                )}
                <p className="cell-sub">
                  Rendered whole, by the browser&apos;s built-in PDF viewer. Chromium and Firefox
                  jump to a specific cited page when the link asks for one; Safari&apos;s viewer is
                  inconsistent about honouring that.
                </p>
              </>
            ) : (
              <EvidenceReader versionId={version.id} />
            )
          }
          secondary={
            <>
              <div className="card">
                <div className="card-head">
                  <h2 className="card-title">v{version.versionNumber}</h2>
                  <Badge tone={INGESTION_TONE[version.ingestionStatus]}>
                    {version.ingestionStatus}
                  </Badge>
                </div>
                {version.ingestionFailureReason && (
                  <p className="cell-sub">{version.ingestionFailureReason}</p>
                )}
                {/* Silent on an empty array, matching VersionRow: a reader deciding whether to
                    trust this version needs to know the text behind it is only part of what the
                    source said, alongside 'completed' rather than instead of it. */}
                {version.reducedFidelityReasons.length > 0 && (
                  <>
                    <Badge tone="caution">reduced fidelity</Badge>
                    <ul className="fidelity-list">
                      {version.reducedFidelityReasons.map((reason) => (
                        <li key={reason} className="cell-sub">
                          {reason}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="cell-sub">{formatBytes(version.sizeBytes)}</p>
                <p className="cell-sub mono">
                  <span title={version.sha256}>{truncateSha256(version.sha256)}</span>
                </p>
                <p className="cell-sub">
                  Uploaded <Timestamp value={version.createdAt} />
                </p>
                <div className="form-actions">
                  <a
                    className="btn btn--secondary btn--sm"
                    href={documentVersionContentUrl(version.id)}
                  >
                    <IconDownload />
                    Download
                  </a>
                </div>
              </div>
              {isPdf && (
                <EvidenceReader versionId={version.id} onTargetPageChange={setResolvedPage} />
              )}
            </>
          }
        />
      )}
    </div>
  );
}
