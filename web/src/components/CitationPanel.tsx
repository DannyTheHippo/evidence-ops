import { Link } from 'react-router-dom';
import type { Citation } from '../api/client';
import { formatLocator } from '../lib/locator';
import type { ResolvedVersion } from '../lib/document-index';

interface CitationPanelProps {
  citation: Citation;
  resolved?: ResolvedVersion;
}

export default function CitationPanel({ citation, resolved }: CitationPanelProps) {
  const locatorLabel = formatLocator(citation.locator);
  const title = resolved?.documentTitle ?? 'Unknown document';

  return (
    <li className="citation">
      <blockquote className="citation-quote">{citation.quote}</blockquote>
      <p className="citation-locator mono">
        {resolved ? (
          <Link to={`/documents/${resolved.documentId}`}>{title}</Link>
        ) : (
          <span>{title}</span>
        )}
        {` — ${locatorLabel}`}
      </p>
    </li>
  );
}
