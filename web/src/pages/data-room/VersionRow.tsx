import { documentVersionContentUrl, type DocumentVersion } from '../../api/client';
import Badge from '../../components/ui/Badge';
import FidelityNotice from '../../components/FidelityNotice';
import LinkButton from '../../components/ui/LinkButton';
import { TableCell } from '../../components/ui/Table';
import { IconDownload } from '../../components/icons';
import { workbenchHref } from '../../lib/citation-link';
import { truncateSha256 } from '../../lib/identifiers';
import { formatBytes } from './format-size';
import { INGESTION_TONE } from './ingestion-status';

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
        <FidelityNotice reasons={version.reducedFidelityReasons} />
      </TableCell>
      {/* The full digest is the chain-of-custody value, but 64 hex characters crowd out the
          rest of the row — head and tail on screen, whole value on hover. */}
      <TableCell label="sha256" className="cell-sub mono">
        <span title={version.sha256}>{truncateSha256(version.sha256)}</span>
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        <div className="form-actions">
          <LinkButton
            to={workbenchHref({ documentId, versionId: version.id })}
            variant="secondary"
            size="sm"
          >
            Open in reader
          </LinkButton>
          <LinkButton href={documentVersionContentUrl(version.id)} variant="secondary" size="sm">
            <IconDownload />
            Download
          </LinkButton>
        </div>
      </TableCell>
    </tr>
  );
}
