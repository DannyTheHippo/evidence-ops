import { useEffect, useRef, useState } from 'react';
import { startQuestion, type Answer } from '../../api/client';
import AnswerWorkspace from '../../components/AnswerWorkspace';
import Button from '../../components/ui/Button';
import { useAnswerRun } from '../../lib/use-answer-run';
import { useFormSubmit } from '../../lib/use-form-submit';

interface AnswerComposerProps {
  /** A question to seed the draft with — the Answers page's `?q=` query param, itself set by a
   * rephrase/prefill link elsewhere. Adopted at mount via a lazy initializer and again, without a
   * remount, by the render-time check below. */
  initialQuestion?: string;
  /** Runs once `startQuestion()` resolves and the run has been seeded, so the page can refresh
   * its history list to pick up the new `queued` row. */
  onRunStarted?: () => void;
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

// Static suggestions, not a recent-query history: a localStorage history would persist tenant
// content unscoped on a shared machine.
const EXAMPLE_QUESTIONS = [
  'What is the cap rate for Northgate Business Park in Q1 2025?',
  'What is the current occupancy rate across the portfolio?',
  'Are there any conflicting rent roll figures this quarter?',
];

export default function AnswerComposer({
  initialQuestion,
  onRunStarted,
  pollIntervalMs,
}: AnswerComposerProps) {
  // The lazy initializer covers a fresh mount, reading before first paint. On its own it would
  // never re-fire on this route: AnswerView's rephrase link renders inside this same composer on
  // /answers, so following it changes `?q=` without remounting the page — the render-time check
  // below is what adopts that later change instead.
  const [questionText, setQuestionText] = useState(() => initialQuestion ?? '');
  // Tracks the `initialQuestion` already reacted to, so a later prop change is adopted at most
  // once per value — the sanctioned "adjusting state when a prop changes" pattern
  // (react.dev/learn/you-might-not-need-an-effect; use-answer-run.ts's own `resetForId` uses the
  // same escape hatch), applied during render rather than a subsequent effect. A non-empty value
  // is adopted into the draft; an empty one (the page strips `?q=` right after adoption) is only
  // recorded here, never applied, so a draft typed since is never cleared.
  const [adoptedQuestion, setAdoptedQuestion] = useState(initialQuestion);
  if (initialQuestion !== adoptedQuestion) {
    setAdoptedQuestion(initialQuestion);
    if (initialQuestion) setQuestionText(initialQuestion);
  }
  const [answerId, setAnswerId] = useState<string | null>(null);
  // The optimistic snapshot built from startQuestion()'s own response, seeded into
  // useAnswerRun() so its initial fetch is skipped — the server has nothing more to say about a
  // run created in this same tick.
  const [seedAnswer, setSeedAnswer] = useState<Answer | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { pending, formError, onSubmit, fieldProps } = useFormSubmit<'questionText'>({
    validate: () => (questionText.trim() ? {} : { questionText: 'Enter a question' }),
    submit: async () => {
      const result = await startQuestion(questionText);
      setSeedAnswer({
        id: result.id,
        questionText,
        runStatus: result.runStatus,
        citations: [],
        atoms: [],
        conflictIds: [],
        createdAt: new Date().toISOString(),
        withdrawnCitedDocVersionIds: [],
      });
      setAnswerId(result.id);
      onRunStarted?.();
    },
  });
  const { id: questionId, error: questionError } = fieldProps('questionText');

  // A failed submit always refocuses the input. The trimmed-empty case is covered by the hook's
  // own scheduleFocus (see use-form-submit.ts); this covers the other case it deliberately leaves
  // alone — a plain request failure, reported as `formError` with no field to focus instead.
  useEffect(() => {
    if (formError) inputRef.current?.focus();
  }, [formError]);

  function fillExample(example: string) {
    setQuestionText(example);
    inputRef.current?.focus();
  }

  const { answer, error: runError } = useAnswerRun({
    answerId,
    pollIntervalMs,
    initialAnswer: seedAnswer,
  });

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Ask a question</h2>
        </div>
        <form onSubmit={onSubmit} className="form" noValidate>
          <div className="composer-row">
            {/* Label-less against the heading above, not the page title — the page itself is
                titled "Answers", which the question field would only repeat. */}
            <input
              ref={inputRef}
              id={questionId}
              type="text"
              aria-label="Question"
              aria-describedby={questionError ? `${questionId}-error` : undefined}
              aria-invalid={questionError ? true : undefined}
              className="composer-input"
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              placeholder="What is the cap rate for Northgate Business Park in Q1 2025?"
              disabled={pending}
            />
            <Button type="submit" variant="primary" className="composer-ask" disabled={pending}>
              {pending ? 'Asking…' : 'Ask'}
            </Button>
          </div>
          {questionError && (
            <p id={`${questionId}-error`} className="field-error">
              {questionError}
            </p>
          )}
          <div className="composer-meta">
            <p className="composer-hint">
              Press <kbd>Enter</kbd> to ask.
            </p>
            {!answerId && (
              <div className="composer-examples">
                {EXAMPLE_QUESTIONS.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="btn btn--sm example-chip"
                    disabled={pending}
                    onClick={() => fillExample(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>
      </section>

      {formError && (
        <p className="error" role="alert">
          {formError}
        </p>
      )}

      {answer && <AnswerWorkspace answer={answer} variant="ask" />}

      {runError && (
        <p className="error" role="alert">
          {runError}
        </p>
      )}
    </>
  );
}
