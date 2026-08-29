import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import {
  ApiError,
  documentVersionContentUrl,
  fetchDocumentVersionContent,
  getDocumentById,
  type DocumentVersion,
  type DocumentWithVersions,
} from '../api/client';
import Badge from '../components/ui/Badge';
import DescriptionList from '../components/ui/DescriptionList';
import LinkButton from '../components/ui/LinkButton';
import PageHeader from '../components/ui/PageHeader';
import Skeleton from '../components/ui/Skeleton';
import SplitView from '../components/ui/SplitView';
import Timestamp from '../components/ui/Timestamp';
import FidelityNotice from '../components/FidelityNotice';
import { IconDownload } from '../components/icons';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { formatRelativeTimestamp } from '../lib/format-timestamp';
import { truncateSha256 } from '../lib/identifiers';
import { useObjectUrl } from '../lib/use-object-url';
import { formatBytes } from './data-room/format-size';
import { INGESTION_TONE } from './data-room/ingestion-status';
import EvidenceReader from './document-workbench/EvidenceReader';

function findVersion(doc: DocumentWithVersions, versionId: string): DocumentVersion | undefined {
  return doc.versions.find((version) => version.id === versionId);
}

/** The version-detail rows for the workbench's secondary pane. Failure reason and fidelity rows
 * are omitted entirely rather than rendered empty — a version with neither has nothing to say
 * about either, matching `VersionRow`'s own silence on an empty `reducedFidelityReasons`. */
function versionDetailItems(version: DocumentVersion): { term: string; description: ReactNode }[] {
  const items: { term: string; description: ReactNode }[] = [
    {
      term: 'Status',
      description: (
        <Badge tone={INGESTION_TONE[version.ingestionStatus]}>{version.ingestionStatus}</Badge>
      ),
    },
  ];
  if (version.ingestionFailureReason) {
    items.push({ term: 'Failure reason', description: version.ingestionFailureReason });
  }
  if (version.reducedFidelityReasons.length > 0) {
    items.push({
      term: 'Fidelity',
      description: <FidelityNotice reasons={version.reducedFidelityReasons} />,
    });
  }
  items.push(
    { term: 'Size', description: formatBytes(version.sizeBytes) },
    {
      term: 'sha256',
      description: (
        <span className="mono" title={version.sha256}>
          {truncateSha256(version.sha256)}
        </span>
      ),
    },
    { term: 'Uploaded', description: <Timestamp value={version.createdAt} /> },
  );
  return items;
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

  useBreadcrumbs([
    { label: 'Data Room', to: '/documents' },
    {
      label: doc ? doc.title : 'Document',
      to: documentId ? `/documents/${documentId}` : undefined,
    },
    { label: version ? `Version ${version.versionNumber}` : 'Version' },
  ]);

  return (
    <div className="view">
      <PageHeader
        eyebrow="Evidence"
        title={doc ? doc.title : 'Document'}
        description={
          version
            ? `Version ${version.versionNumber} · uploaded ${formatRelativeTimestamp(version.createdAt)}`
            : 'Document workbench'
        }
        actions={
          <>
            {version && (
              <Badge tone={INGESTION_TONE[version.ingestionStatus]}>
                {version.ingestionStatus}
              </Badge>
            )}
            {documentId && (
              <LinkButton to={`/documents/${documentId}`} variant="secondary" size="sm">
                Back to document
              </LinkButton>
            )}
          </>
        }
      />

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
              <EvidenceReader versionId={version.id} variant="reading" />
            )
          }
          secondary={
            <>
              <div className="card">
                <div className="card-head">
                  <h2 className="card-title">v{version.versionNumber}</h2>
                </div>
                <DescriptionList items={versionDetailItems(version)} />
                <div className="form-actions">
                  <LinkButton
                    href={documentVersionContentUrl(version.id)}
                    variant="secondary"
                    size="sm"
                  >
                    <IconDownload />
                    Download
                  </LinkButton>
                </div>
              </div>
              {isPdf && (
                <EvidenceReader
                  versionId={version.id}
                  variant="rail"
                  onTargetPageChange={setResolvedPage}
                />
              )}
            </>
          }
        />
      )}
    </div>
  );
}
