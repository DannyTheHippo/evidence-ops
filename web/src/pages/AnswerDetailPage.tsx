import { Link, useParams } from 'react-router-dom';
import AnswerWorkspace from '../components/AnswerWorkspace';
import CopyButton from '../components/ui/CopyButton';
import EmptyState from '../components/ui/EmptyState';
import LinkButton from '../components/ui/LinkButton';
import PageHeader from '../components/ui/PageHeader';
import Skeleton from '../components/ui/Skeleton';
import Timestamp from '../components/ui/Timestamp';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { shortId } from '../lib/identifiers';
import { useAnswerRun } from '../lib/use-answer-run';

interface AnswerDetailPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

export default function AnswerDetailPage({ pollIntervalMs }: AnswerDetailPageProps) {
  const { id } = useParams<{ id: string }>();
  const { answer, error, notFound } = useAnswerRun({ answerId: id ?? null, pollIntervalMs });

  useBreadcrumbs([
    { label: 'Ask', to: '/ask' },
    { label: 'Answers', to: '/answers' },
    { label: answer ? answer.questionText : 'Answer' },
  ]);

  return (
    <div className="view view--roomy answer-detail">
      <PageHeader
        eyebrow="Ask"
        title={answer ? answer.questionText : 'Answer'}
        actions={
          <div className="form-actions">
            <LinkButton to="/ask" variant="ghost" size="sm">
              Ask a follow-up
            </LinkButton>
            <LinkButton to="/answers" variant="secondary" size="sm">
              Back to answers
            </LinkButton>
          </div>
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
        </p>
      )}

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!id && (
        <p className="error error--page" role="alert">
          No answer id provided.
        </p>
      )}

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

      {answer && <AnswerWorkspace answer={answer} variant="detail" />}

      {answer && answer.runStatus === 'failed' && (
        <div className="form-actions">
          <Link
            to="/ask"
            state={{ questionText: answer.questionText }}
            className="btn btn--secondary btn--sm"
          >
            Ask this question again
          </Link>
        </div>
      )}
    </div>
  );
}
