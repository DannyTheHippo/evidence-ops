import { Link, useParams } from 'react-router-dom';
import AnswerWorkspace from '../components/AnswerWorkspace';
import Skeleton from '../components/ui/Skeleton';
import { useAnswerRun } from '../lib/use-answer-run';

interface AnswerDetailPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

export default function AnswerDetailPage({ pollIntervalMs }: AnswerDetailPageProps) {
  const { id } = useParams<{ id: string }>();
  const { answer, error, notFound } = useAnswerRun({ answerId: id ?? null, pollIntervalMs });

  return (
    <div className="view view--roomy">
      <div className="page-head">
        <div>
          <span className="eyebrow">Ask</span>
          <h1 className="page-title">{answer ? answer.questionText : 'Answer'}</h1>
          <p className="page-sub">A previously asked question and its grounding.</p>
        </div>
        <Link to="/answers" className="btn btn--secondary btn--sm">
          Back to answers
        </Link>
      </div>

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

      {notFound && <p className="notice notice--info">Answer not found.</p>}

      {!answer && !error && !notFound && id && <Skeleton label="Loading answer…" />}

      {answer && <AnswerWorkspace answer={answer} variant="detail" />}
    </div>
  );
}
