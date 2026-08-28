import { useRef, useState, type FormEvent } from 'react';
import { startQuestion, type Answer } from '../api/client';
import AnswerWorkspace from '../components/AnswerWorkspace';
import Button from '../components/ui/Button';
import Field from '../components/ui/Field';
import { notify } from '../components/ui/toast';
import { useAnswerRun } from '../lib/use-answer-run';

interface AskPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

export default function AskPage({ pollIntervalMs }: AskPageProps) {
  const [questionText, setQuestionText] = useState('');
  const [answerId, setAnswerId] = useState<string | null>(null);
  // The optimistic snapshot built from startQuestion()'s own response, seeded into
  // useAnswerRun() so its initial fetch is skipped — the server has nothing more to say about a
  // run created in this same tick.
  const [seedAnswer, setSeedAnswer] = useState<Answer | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Blocks a double submit between the click and the re-render that disables the submit button —
  // `disabled={submitting}` alone only takes effect once React has committed it.
  const submitInFlightRef = useRef(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setAnswerId(null);
    setSeedAnswer(null);
    try {
      const result = await startQuestion(questionText);
      setSeedAnswer({
        id: result.id,
        questionText,
        runStatus: result.runStatus,
        citations: [],
        conflictIds: [],
        createdAt: new Date().toISOString(),
        withdrawnCitedDocVersionIds: [],
      });
      setAnswerId(result.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to ask question';
      setSubmitError(message);
      notify('error', message);
    } finally {
      setSubmitting(false);
      submitInFlightRef.current = false;
    }
  }

  const { answer, error: runError } = useAnswerRun({
    answerId,
    pollIntervalMs,
    initialAnswer: seedAnswer,
  });
  const error = submitError ?? runError;

  return (
    <div className="view view--roomy">
      <div className="page-head">
        <div>
          <span className="eyebrow">Ask</span>
          <h1 className="page-title">Ask</h1>
          <p className="page-sub">Ask a question grounded in the uploaded evidence.</p>
        </div>
      </div>

      {/* Untitled, unlike a filter card — the question field is the page's purpose, not a
          refinement of something below it, and a "Ask" heading under a page title that already
          reads Ask would repeat itself. */}
      <section className="card">
        <form onSubmit={(e) => void handleSubmit(e)} className="form">
          <Field label="Question">
            {(inputProps) => (
              <input
                type="text"
                required
                value={questionText}
                onChange={(e) => setQuestionText(e.target.value)}
                placeholder="What is the cap rate for Northgate Business Park in Q1 2025?"
                {...inputProps}
              />
            )}
          </Field>
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Asking…' : 'Ask'}
            </Button>
          </div>
        </form>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {answer && <AnswerWorkspace answer={answer} variant="ask" />}
    </div>
  );
}
