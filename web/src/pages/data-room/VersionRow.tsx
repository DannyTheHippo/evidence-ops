import { Link } from 'react-router-dom';
import {
  documentVersionContentUrl,
  type DocumentVersion,
  type DocumentVersionIngestionStatus,
} from '../../api/client';
import Badge, { type BadgeTone } from '../../components/ui/Badge';
import { TableCell } from '../../components/ui/Table';
import { IconDownload } from '../../components/icons';
import { workbenchHref } from '../../lib/citation-link';
import { truncateSha256 } from '../../lib/identifiers';
import { formatBytes } from './format-size';

// 'needs-ocr' and 'facts-failed' carry the same 'caution' tone as 'pending', each deliberately: a
// scanned PDF with no text layer is a gap in the corpus to flag for attention, and a 'facts-failed'
// version has real, citable chunks and only lacks extracted facts. Neither is the
// verification-grade failure 'rejected' signals elsewhere in this app. A total map rather than a
// fallthrough, so a status added to the API's union fails the type-check here instead of silently
// inheriting a tone nobody chose for it.
const INGESTION_TONE: Record<DocumentVersionIngestionStatus, BadgeTone> = {
  pending: 'caution',
  completed: 'verified',
  'facts-failed': 'caution',
  failed: 'rejected',
  'needs-ocr': 'caution',
};

/** One version row in `DocumentDetail`'s version table. `documentId` comes from the caller — a
 * `DocumentVersionResponseDto` carries no reference back to its owning document. */
export default function VersionRow({
  version,
  documentId,
}: {
  version: DocumentVersion;
  documentId: string;
}) {
  return (
    <tr>
      <TableCell label="Version" className="num">
        v{version.versionNumber}
      </TableCell>
      <TableCell label="Size" className="num">
        {formatBytes(version.sizeBytes)}
      </TableCell>
      <TableCell label="Ingestion">
        <Badge tone={INGESTION_TONE[version.ingestionStatus]}>{version.ingestionStatus}</Badge>
        {version.ingestionFailureReason && (
          <p className="cell-sub">{version.ingestionFailureReason}</p>
        )}
        {/* Silent on an empty array. A reader deciding whether to trust this version — or a
            citation drawn from it — needs to know the text behind it is only part of what the
            source said, and that qualification stands alongside a 'completed' status rather
            than replacing it. */}
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
      </TableCell>
      {/* The full digest is the chain-of-custody value, but 64 hex characters crowd out the
          rest of the row — head and tail on screen, whole value on hover. */}
      <TableCell label="sha256" className="cell-sub mono">
        <span title={version.sha256}>{truncateSha256(version.sha256)}</span>
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        <div className="form-actions">
          <Link
            className="btn btn--secondary btn--sm"
            to={workbenchHref({ documentId, versionId: version.id })}
          >
            Open in reader
          </Link>
          <a className="btn btn--secondary btn--sm" href={documentVersionContentUrl(version.id)}>
            <IconDownload />
            Download
          </a>
        </div>
      </TableCell>
    </tr>
  );
}
