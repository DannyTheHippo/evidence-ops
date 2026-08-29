import Badge from './ui/Badge';

interface FidelityNoticeProps {
  reasons: string[];
}

/** A version's or document's known fidelity gaps — a scanned page with no text layer, an
 * ambiguous header row inferred rather than read — set off from the rest of the cell by a
 * hairline left rule, alongside a `'caution'` badge naming the gap. Silent on an empty array: a
 * reader deciding whether to trust a citation drawn from it needs to know the text behind it is
 * only part of what the source said, and that qualification stands alongside a `'completed'`
 * status rather than replacing it — but it has nothing to say when there is no known gap.
 * Shared by `VersionRow` and the document workbench, both of which render a version's fidelity
 * reasons next to its ingestion badge. */
export default function FidelityNotice({ reasons }: FidelityNoticeProps) {
  if (reasons.length === 0) return null;

  return (
    <div className="fidelity-notice">
      <Badge tone="caution">reduced fidelity</Badge>
      <ul className="fidelity-list">
        {reasons.map((reason) => (
          <li key={reason} className="cell-sub">
            {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
