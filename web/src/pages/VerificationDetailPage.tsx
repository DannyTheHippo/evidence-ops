import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, getVerificationById, type ClaimVerdict, type Verification } from '../api/client';
import AttestationBundleView from '../components/AttestationBundleView';
import Alert from '../components/ui/Alert';
import Badge, { type BadgeTone } from '../components/ui/Badge';
import CopyButton from '../components/ui/CopyButton';
import DescriptionList from '../components/ui/DescriptionList';
import EmptyState from '../components/ui/EmptyState';
import LinkButton from '../components/ui/LinkButton';
import PageHeader from '../components/ui/PageHeader';
import Panel from '../components/ui/Panel';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { VERDICT_LABELS } from '../lib/answer-verdicts';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { shortId, truncateSha256 } from '../lib/identifiers';
import { formatLocator } from '../lib/locator';
import { useAbortableEffect } from '../lib/use-latest';
import { useSession } from '../lib/use-session';

// Mirrors the verdict-to-tone mapping the attestation bundle uses for the same four grounding-
// check outcomes; a submitted verification never reaches the bundle-only `survived`/`dropped`
// verdicts, so this map covers `ClaimVerdict` rather than the bundle's wider union.
const VERDICT_TONE: Record<ClaimVerdict, BadgeTone> = {
  grounded: 'verified',
  not_grounded: 'rejected',
  no_evidence_retrieved: 'neutral',
  conflicting_evidence: 'caution',
};

/**
 * Read-only detail view for one verification run: who requested it, the fixed advisory every
 * result carries, the admin-only run cost, and — via `AttestationBundleView` — the same claim,
 * decision and integrity rendering `AnswerDetailPage` shows for an answer. There is no
 * verify-from-console form here; a new run is started from the MCP surface or `AnswersPage`.
 */
export default function VerificationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [verification, setVerification] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const session = useSession();
  const isAdmin = session.status === 'authed' && session.me.role === 'admin';

  useAbortableEffect(
    (isCurrent) => {
      if (!id) return;

      getVerificationById(id)
        .then((result) => {
          if (isCurrent()) setVerification(result);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          if (err instanceof ApiError && err.status === 404) {
            setNotFound(true);
            return;
          }
          setError(err instanceof Error ? err.message : 'Failed to load verification');
        });
    },
    [id],
  );

  useBreadcrumbs([
    { label: 'Answers', to: '/answers' },
    {
      label: verification
        ? `${verification.claims.length} claim${verification.claims.length === 1 ? '' : 's'}`
        : 'Verification',
    },
  ]);

  return (
    <div className="view view--roomy answer-detail">
      <PageHeader
        eyebrow="Answers"
        title={verification ? verification.claims[0] : 'Verification'}
        actions={
          <LinkButton to="/answers" variant="secondary" size="sm">
            Back to answers
          </LinkButton>
        }
      />

      {verification && (
        <p className="answer-detail-meta">
          <span>
            Requested <Timestamp value={verification.createdAt} />
          </span>
          <Badge tone="neutral">{verification.requestedBy.kind}</Badge>
          <span className="mono" title={verification.id}>
            {shortId(verification.id)}
          </span>
          <CopyButton text={verification.id} label="Copy id" iconOnly />
        </p>
      )}

      {error && <Alert tone="rejected">{error}</Alert>}

      {notFound && (
        <EmptyState
          title="Verification not found."
          action={
            <LinkButton to="/answers" variant="secondary" size="sm">
              View all answers
            </LinkButton>
          }
        />
      )}

      {!verification && !error && !notFound && id && <Skeleton label="Loading verification…" />}

      {verification && (
        <>
          <Alert tone="info">{verification.advisory}</Alert>

          {isAdmin && (
            <div className="run-cost-footer">
              <DescriptionList
                items={[
                  {
                    term: 'Run cost',
                    description: (
                      <span className="mono">{`$${verification.usage.costUsd.toFixed(4)}`}</span>
                    ),
                  },
                ]}
              />
            </div>
          )}

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Claims and verdicts</h2>
            </div>
            <Panel aria-label="Claims and verdicts">
              <Table caption="Claims and verdicts">
                <thead>
                  <tr>
                    <TableHeaderCell>Claim</TableHeaderCell>
                    <TableHeaderCell>Verdict</TableHeaderCell>
                    <TableHeaderCell>Reason</TableHeaderCell>
                    <TableHeaderCell>Citations</TableHeaderCell>
                  </tr>
                </thead>
                <tbody>
                  {verification.results.map((result, resultIndex) => (
                    <tr key={`result-${resultIndex}`}>
                      <TableCell label="Claim">{verification.claims[result.claimIndex]}</TableCell>
                      <TableCell label="Verdict">
                        <Badge tone={VERDICT_TONE[result.verdict]}>
                          {VERDICT_LABELS[result.verdict]}
                        </Badge>
                      </TableCell>
                      <TableCell label="Reason">{result.reasonCode ?? '—'}</TableCell>
                      <TableCell label="Citations">
                        {result.citations && result.citations.length > 0 ? (
                          <ul className="citations">
                            {result.citations.map((citation, citationIndex) => (
                              <li key={citationIndex} className="citation">
                                <span className="trace-chip mono">
                                  {formatLocator(citation.locator)} ·{' '}
                                  {truncateSha256(citation.chunkId)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="cell-sub">—</span>
                        )}
                      </TableCell>
                    </tr>
                  ))}
                  {verification.claims
                    .map((statement, claimIndex) => ({ statement, claimIndex }))
                    .filter(
                      ({ claimIndex }) =>
                        !verification.results.some((result) => result.claimIndex === claimIndex),
                    )
                    .map(({ statement, claimIndex }) => (
                      <tr key={`missing-${claimIndex}`}>
                        <TableCell label="Claim">{statement}</TableCell>
                        <TableCell label="Verdict">
                          <span className="cell-sub">No result recorded</span>
                        </TableCell>
                        <TableCell label="Reason">
                          <span className="cell-sub">—</span>
                        </TableCell>
                        <TableCell label="Citations">
                          <span className="cell-sub">—</span>
                        </TableCell>
                      </tr>
                    ))}
                </tbody>
              </Table>
            </Panel>
          </section>

          <AttestationBundleView
            kind="verifications"
            subjectId={verification.id}
            attestationHash={verification.attestationHash}
          />
        </>
      )}
    </div>
  );
}
