import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAttestation, type AttestationBundle, type AttestationKind } from '../api/client';
import {
  answerOutcomeLabel,
  BUNDLE_VERDICT_LABELS,
  DECISION_OUTCOME_LABELS,
} from '../lib/answer-verdicts';
import { workbenchHref } from '../lib/citation-link';
import { resolveDocumentVersions, type ResolvedVersion } from '../lib/document-index';
import { truncateSha256 } from '../lib/identifiers';
import { formatLocator } from '../lib/locator';
import { metricLabel, useMetricLabels } from '../lib/metric-labels';
import Badge, { type BadgeTone } from './ui/Badge';
import Button from './ui/Button';
import CopyButton from './ui/CopyButton';
import DescriptionList from './ui/DescriptionList';
import LinkButton from './ui/LinkButton';
import Panel from './ui/Panel';
import Skeleton from './ui/Skeleton';
import Table, { TableCell, TableHeaderCell } from './ui/Table';
import Timestamp from './ui/Timestamp';
import Tooltip from './ui/Tooltip';

// A claim's verdict is either a real grounding-check verdict (`ClaimVerdict`) or one of the two
// bundle-only outcomes a claim not carried by the model's own `AnswerOutcome` can still hold:
// `survived` (a verification claim the check passed) and `dropped` (one it did not). `grounded`
// and `survived` both mean the claim held up; `not_grounded` and `dropped` both mean it did not.
const VERDICT_TONE: Record<AttestationBundle['claims'][number]['verdict'], BadgeTone> = {
  grounded: 'verified',
  survived: 'verified',
  not_grounded: 'rejected',
  dropped: 'rejected',
  no_evidence_retrieved: 'neutral',
  conflicting_evidence: 'caution',
};

interface AttestationBundleViewProps {
  kind: AttestationKind;
  subjectId: string;
  attestationHash?: string;
}

/**
 * The exportable evidence bundle behind a completed answer or a verification: every claim
 * considered, the checks and citations behind its verdict, the human decisions its facts rest on,
 * and the measure definitions it cites. `integrity.contentHash` is tamper-evident only for a
 * recipient who already has it through a trusted channel — this cycle mints no signing key, so
 * the bundle is never described as signed or verified, only as reproducible: the hash and the
 * algorithm that produced it are rendered in full and made copyable so a recipient can recompute
 * and compare it independently. Fetching the bundle pins `attestationHash` on the subject's row
 * server-side, an irreversible write, so this gates CLOSED on `attestationHash`: a subject that
 * already carries a hash auto-loads its existing bundle, and a subject with none waits for the
 * operator to explicitly generate one rather than exporting on a silent mount.
 */
export default function AttestationBundleView({
  kind,
  subjectId,
  attestationHash,
}: AttestationBundleViewProps) {
  const metricLabels = useMetricLabels();
  const [bundle, setBundle] = useState<AttestationBundle | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // Counts the operator's Generate clicks, so a retry after a failed fetch changes the fetch
  // effect's deps and sends a new request.
  const [generateAttempt, setGenerateAttempt] = useState(0);

  // Resets state during render rather than inside the fetch effect below, on the same
  // `resetForId`/`use-answer-run.ts` pattern — a synchronous setState inside an effect body
  // triggers `react-hooks/set-state-in-effect`, and React's own adjust-state-on-prop-change
  // escape hatch (comparing against a previous-render key) is exempt because it bails out on the
  // very same render instead of committing then re-triggering another.
  const key = `${kind}:${subjectId}`;
  const [resetKey, setResetKey] = useState<string | null>(null);
  if (key !== resetKey) {
    setResetKey(key);
    setBundle(null);
    setError(null);
    setDocumentIndex(new Map());
    setGenerateAttempt(0);
  }

  useEffect(() => {
    if (!attestationHash && generateAttempt === 0) return;
    let cancelled = false;

    getAttestation(kind, subjectId)
      .then((result) => {
        if (cancelled) return;
        setBundle(result);
        const versionIds = result.claims.flatMap((claim) =>
          claim.citations.map((citation) => citation.documentVersionId),
        );
        resolveDocumentVersions(versionIds)
          .then((index) => {
            if (!cancelled) setDocumentIndex(index);
          })
          .catch(() => {});
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load attestation');
      });

    return () => {
      cancelled = true;
    };
  }, [kind, subjectId, attestationHash, generateAttempt]);

  // Object URLs created for a download outlive the click that triggers them — an anchor's
  // navigation can resolve after this function returns, so revoking synchronously here can race
  // it. Each URL is retired on unmount instead, once nothing can still be reading it.
  const objectUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  function downloadBundle() {
    if (!bundle) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
    );
    objectUrlsRef.current.push(url);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `attestation-${kind === 'answers' ? 'answer' : 'verification'}-${subjectId}.json`;
    anchor.click();
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Attestation</h2>
        {!attestationHash && !bundle && (
          <p className="cell-sub">
            Generating the bundle pins its hash to this record permanently.
          </p>
        )}
        {bundle || attestationHash ? (
          <Button variant="secondary" size="sm" onClick={downloadBundle} disabled={!bundle}>
            Download attestation
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            busy={generateAttempt > 0 && !error}
            busyLabel="Generating…"
            onClick={() => {
              setError(null);
              setGenerateAttempt((attempt) => attempt + 1);
            }}
          >
            Generate attestation
          </Button>
        )}
      </div>

      {!bundle && !error && (attestationHash || generateAttempt > 0) && (
        <Skeleton label="Loading attestation…" />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {bundle && (
        <>
          <DescriptionList
            columns={2}
            items={[
              { term: 'Produced', description: <Timestamp value={bundle.producedAt} /> },
              { term: 'Outcome', description: answerOutcomeLabel(bundle.outcome) },
              {
                term: 'Integrity',
                description: (
                  <>
                    <span className="mono" title={bundle.integrity.contentHash}>
                      {bundle.integrity.algorithm} · {truncateSha256(bundle.integrity.contentHash)}
                    </span>
                    <CopyButton text={bundle.integrity.contentHash} label="Copy hash" iconOnly />
                    <span className="cell-sub">
                      This bundle is not signed. The hash detects tampering only when compared
                      against a copy you received separately.
                    </span>
                  </>
                ),
              },
              {
                term: 'Measures',
                description:
                  bundle.measures.length > 0
                    ? bundle.measures
                        .map((measure) => `${measure.slug} v${measure.version} (${measure.status})`)
                        .join(', ')
                    : '—',
              },
            ]}
          />

          <h3 className="card-subtitle">Attested claims</h3>
          <Panel aria-label="Attested claims">
            <Table caption="Attested claims">
              <thead>
                <tr>
                  <TableHeaderCell>Claim</TableHeaderCell>
                  <TableHeaderCell>Verdict</TableHeaderCell>
                  <TableHeaderCell>Checks</TableHeaderCell>
                  <TableHeaderCell>Citations</TableHeaderCell>
                </tr>
              </thead>
              <tbody>
                {bundle.claims.map((claim, claimIndex) => (
                  <tr key={claimIndex}>
                    <TableCell label="Claim">
                      {claim.statement}
                      {claim.atoms && claim.atoms.length > 0 && (
                        <ul className="cell-sub">
                          {claim.atoms.map((atom, atomIndex) => (
                            <li key={atomIndex}>{atom}</li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell label="Verdict">
                      <Badge tone={VERDICT_TONE[claim.verdict]}>
                        {BUNDLE_VERDICT_LABELS[claim.verdict]}
                      </Badge>
                    </TableCell>
                    <TableCell label="Checks">
                      <ul className="attestation-list" role="list">
                        {claim.checks.map((check, checkIndex) => (
                          <li key={checkIndex}>
                            {check.name} — {check.passed ? 'passed' : 'failed'}
                            {check.detail && <span className="cell-sub"> {check.detail}</span>}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell label="Citations">
                      <ul className="citations">
                        {claim.citations.map((citation, citationIndex) => (
                          <li key={citationIndex} className="citation">
                            <span className="trace-chip mono">
                              {formatLocator(citation.locator)}
                            </span>
                            {citation.documentId !== null && (
                              <Tooltip content={citation.quote}>
                                <Link
                                  className="trace-chip mono"
                                  to={workbenchHref({
                                    documentId: citation.documentId,
                                    versionId: citation.documentVersionId,
                                  })}
                                >
                                  {documentIndex.get(citation.documentVersionId)?.documentTitle ??
                                    truncateSha256(citation.sha256)}
                                </Link>
                              </Tooltip>
                            )}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>

          <h3 className="card-subtitle">Decisions</h3>
          {bundle.decisions.length === 0 ? (
            <p className="cell-sub">No adjudication decisions apply to this attestation.</p>
          ) : (
            <ul className="attestation-list" role="list">
              {bundle.decisions.map((decision, decisionIndex) => (
                <li key={decisionIndex}>
                  <p>
                    {decision.factKey.entity} · {metricLabel(decision.factKey.metric, metricLabels)}{' '}
                    · {decision.factKey.period}
                  </p>
                  <DescriptionList
                    columns={2}
                    items={[
                      { term: 'Outcome', description: DECISION_OUTCOME_LABELS[decision.outcome] },
                      { term: 'Decided by', description: decision.decidedBy ?? '—' },
                      { term: 'Reason', description: decision.reason ?? '—' },
                      {
                        term: 'Resolved at',
                        description: <Timestamp value={decision.resolvedAt} />,
                      },
                      { term: 'Rule fired', description: decision.ruleFired ?? '—' },
                      {
                        term: 'Followed proposal',
                        description:
                          decision.followedProposal === undefined
                            ? '—'
                            : decision.followedProposal
                              ? 'Yes'
                              : 'No',
                      },
                    ]}
                  />
                  <LinkButton
                    to={`/adjudication?kind=conflicts&selected=${decision.conflictId}`}
                    variant="ghost"
                    size="sm"
                  >
                    Open in Adjudication
                  </LinkButton>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
