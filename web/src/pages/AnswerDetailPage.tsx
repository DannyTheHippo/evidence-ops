import { useParams } from 'react-router-dom';
import AnswerWorkspace from '../components/AnswerWorkspace';
import AttestationBundleView from '../components/AttestationBundleView';
import Alert from '../components/ui/Alert';
import Badge from '../components/ui/Badge';
import CopyButton from '../components/ui/CopyButton';
import EmptyState from '../components/ui/EmptyState';
import LinkButton from '../components/ui/LinkButton';
import PageHeader from '../components/ui/PageHeader';
import Skeleton from '../components/ui/Skeleton';
import Timestamp from '../components/ui/Timestamp';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { shortId, truncateSha256 } from '../lib/identifiers';
import { useAnswerRun } from '../lib/use-answer-run';

interface AnswerDetailPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

export default function AnswerDetailPage({ pollIntervalMs }: AnswerDetailPageProps) {
  const { id } = useParams<{ id: string }>();
  const { answer, error, notFound, streamState } = useAnswerRun({
    answerId: id ?? null,
    pollIntervalMs,
  });
  const followUpHref = answer
    ? `/answers?q=${encodeURIComponent(answer.questionText)}`
    : '/answers';
  // The document title reads the crumb label, not the PageHeader title below, so an unclamped
  // question renders an unreadably long browser tab; the topbar's own `.breadcrumb-current`
  // already truncates the rendered crumb visually.
  const crumbLabel = answer
    ? answer.questionText.length > 60
      ? `${answer.questionText.slice(0, 60)}…`
      : answer.questionText
    : 'Answer';

  useBreadcrumbs([{ label: 'Answers', to: '/answers' }, { label: crumbLabel }]);

  return (
    <div className="view view--roomy answer-detail">
      <PageHeader
        eyebrow="Answers"
        title={answer ? answer.questionText : 'Answer'}
        actions={
          <>
            <LinkButton to={followUpHref} variant="ghost" size="sm">
              Ask a follow-up
            </LinkButton>
            <LinkButton to="/answers" variant="secondary" size="sm">
              Back to answers
            </LinkButton>
          </>
        }
      />

      {answer && (
        <p className="answer-detail-meta">
          <span>
            Asked <Timestamp value={answer.createdAt} />
          </span>
          <span className="mono" title={answer.id}>
            {shortId(answer.id)}
          </span>
          <CopyButton text={answer.id} label="Copy id" iconOnly />
          {answer.answerPath && <Badge tone="neutral">{answer.answerPath}</Badge>}
          {answer.attestationHash && (
            <span className="mono" title={answer.attestationHash}>
              {truncateSha256(answer.attestationHash)}
            </span>
          )}
        </p>
      )}

      {error && <Alert tone="rejected">{error}</Alert>}

      {!id && <Alert tone="rejected">No answer id provided.</Alert>}

      {notFound && (
        <EmptyState
          title="Answer not found."
          action={
            <LinkButton to="/answers" variant="secondary" size="sm">
              View all answers
            </LinkButton>
          }
        />
      )}

      {!answer && !error && !notFound && id && <Skeleton label="Loading answer…" />}

      {answer && <AnswerWorkspace answer={answer} variant="detail" streamState={streamState} />}

      {answer && answer.runStatus === 'completed' && (
        <AttestationBundleView
          kind="answers"
          subjectId={answer.id}
          attestationHash={answer.attestationHash}
        />
      )}
    </div>
  );
}
