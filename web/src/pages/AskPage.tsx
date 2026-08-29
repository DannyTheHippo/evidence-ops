import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { startQuestion, type Answer } from '../api/client';
import AnswerWorkspace from '../components/AnswerWorkspace';
import Button from '../components/ui/Button';
import PageHeader from '../components/ui/PageHeader';
import { useAnswerRun } from '../lib/use-answer-run';
import { useFormSubmit } from '../lib/use-form-submit';

interface AskPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

interface AskLocationState {
  questionText?: string;
}

// Static suggestions, not a recent-query history: a localStorage history would persist tenant
// content unscoped on a shared machine.
const EXAMPLE_QUESTIONS = [
  'What is the cap rate for Northgate Business Park in Q1 2025?',
  'What is the current occupancy rate across the portfolio?',
  'Are there any conflicting rent roll figures this quarter?',
];

export default function AskPage({ pollIntervalMs }: AskPageProps) {
  const location = useLocation();
  // The redundant-entry prefill contract (WCAG 3.3.7): an "Ask again"/"Rephrase" link elsewhere
  // navigates here with router state rather than a query string, since a question can carry
  // characters a URL would need to encode. Read once, at mount — a later state change on the same
  // route (e.g. the user typing) must never overwrite what they've typed.
  const [questionText, setQuestionText] = useState(
    () => (location.state as AskLocationState | null)?.questionText ?? '',
  );
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
        conflictIds: [],
        createdAt: new Date().toISOString(),
        withdrawnCitedDocVersionIds: [],
      });
      setAnswerId(result.id);
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
    <div className="view view--roomy">
      <PageHeader
        eyebrow="Ask"
        title="Ask"
        description="Ask a question grounded in the uploaded evidence."
      />

      {/* Untitled, unlike a filter card — the question field is the page's purpose, not a
          refinement of something below it, and a heading under a page title that already reads
          Ask would repeat itself. */}
      <section className="card">
        <form onSubmit={onSubmit} className="form" noValidate>
          <div className="composer-row">
            {/* The app's one sanctioned label-less input: a visible label would only repeat the
                page title directly above it. */}
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
    </div>
  );
}
