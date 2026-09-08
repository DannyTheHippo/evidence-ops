import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, getVerificationById, type Verification } from '../api/client';
import AttestationBundleView from '../components/AttestationBundleView';
import Badge from '../components/ui/Badge';
import CopyButton from '../components/ui/CopyButton';
import DescriptionList from '../components/ui/DescriptionList';
import EmptyState from '../components/ui/EmptyState';
import LinkButton from '../components/ui/LinkButton';
import PageHeader from '../components/ui/PageHeader';
import Skeleton from '../components/ui/Skeleton';
import Timestamp from '../components/ui/Timestamp';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { shortId } from '../lib/identifiers';
import { useSession } from '../lib/use-session';

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

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    getVerificationById(id)
      .then((result) => {
        if (!cancelled) setVerification(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load verification');
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

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

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

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
          <p className="notice">{verification.advisory}</p>

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

          <AttestationBundleView kind="verifications" subjectId={verification.id} />
        </>
      )}
    </div>
  );
}
