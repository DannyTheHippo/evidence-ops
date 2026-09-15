import { documentVersionContentUrl, type DocumentVersion } from '../../api/client';
import Badge from '../../components/ui/Badge';
import FidelityNotice from '../../components/FidelityNotice';
import IconButton from '../../components/ui/IconButton';
import LinkButton from '../../components/ui/LinkButton';
import Timestamp from '../../components/ui/Timestamp';
import Tooltip from '../../components/ui/Tooltip';
import { TableCell } from '../../components/ui/Table';
import { IconDownload, IconInfoSquare } from '../../components/icons';
import { workbenchHref } from '../../lib/citation-link';
import { formatBytes } from '../../lib/format-size';
import { truncateSha256 } from '../../lib/identifiers';
import { INGESTION_TONE } from './ingestion-status';

/** One version row in `DocumentDetail`'s version table. `documentId` and `documentTitle` come
 * from the caller — a `DocumentVersionResponseDto` carries no reference back to its owning
 * document. `isCurrent` marks the version the document currently resolves to; `onOpenDetails`
 * opens the full-detail drawer `DocumentDetail` owns, which is the keyboard- and touch-reachable
 * path to the version's full sha256 beside the truncated digest's hover tooltip. */
export default function VersionRow({
  version,
  documentId,
  documentTitle,
  isCurrent,
  onOpenDetails,
}: {
  version: DocumentVersion;
  documentId: string;
  documentTitle: string;
  isCurrent: boolean;
  onOpenDetails: (version: DocumentVersion) => void;
}) {
  return (
    <tr aria-current={isCurrent ? 'true' : undefined}>
      <TableCell label="Version" className="cell-numeric">
        {`v${version.versionNumber} `}
        {isCurrent && <Badge tone="info">Current</Badge>}
      </TableCell>
      <TableCell label="Size" className="cell-numeric">
        {formatBytes(version.sizeBytes)}
      </TableCell>
      <TableCell label="Uploaded" className="cell-numeric">
        <Timestamp value={version.createdAt} />
      </TableCell>
      <TableCell label="Ingestion">
        <Badge tone={INGESTION_TONE[version.ingestionStatus]}>{version.ingestionStatus}</Badge>
        {version.ingestionFailureReason && (
          <p className="cell-sub">{version.ingestionFailureReason}</p>
        )}
        <FidelityNotice reasons={version.reducedFidelityReasons} />
      </TableCell>
      {/* The full digest is the chain-of-custody value, but 64 hex characters crowd out the
          rest of the row — head and tail on screen, whole value in a tooltip on hover or keyboard
          focus; the Details action below also shows it. */}
      <TableCell label="sha256" className="cell-sub mono">
        <Tooltip content={version.sha256}>
          <span tabIndex={0}>{truncateSha256(version.sha256)}</span>
        </Tooltip>
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
          <IconButton
            icon={<IconInfoSquare />}
            aria-label={`Version ${version.versionNumber} details, ${documentTitle}`}
            variant="ghost"
            size="sm"
            onClick={() => onOpenDetails(version)}
          />
        </div>
      </TableCell>
    </tr>
  );
}
