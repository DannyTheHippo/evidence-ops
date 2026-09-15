import { useEffect, useRef, useState } from 'react';
import { listCanonicalEntities, startQuestion, type Answer } from '../../api/client';
import AnswerWorkspace from '../../components/AnswerWorkspace';
import Alert from '../../components/ui/Alert';
import Button from '../../components/ui/Button';
import Combobox, { type ComboboxOption } from '../../components/ui/Combobox';
import { announce } from '../../lib/announce';
import { answerBadge } from '../../lib/answer-status';
import { useAnswerRun } from '../../lib/use-answer-run';
import { useFormSubmit } from '../../lib/use-form-submit';
import { useAbortableEffect } from '../../lib/use-latest';

/** The sentence announced once a run reaches a terminal state — `answer.runStatus` is `'failed'`
 * or `'completed'`. A completed run adds the verification ratio whenever the run produced a
 * report; an abstention (no claims to verify) has none, so it announces the outcome alone. */
function terminalAnnouncement(answer: Answer): string {
  if (answer.runStatus === 'failed') return 'The question run failed.';
  const { label } = answerBadge(answer);
  const report = answer.verificationReport;
  if (!report) return `Answer ready: ${label}.`;
  return `Answer ready: ${label} — ${report.verifiedClaimCount} of ${report.totalClaimCount} claims verified.`;
}

interface AnswerComposerProps {
  /** A question to seed the draft with — the Answers page's `?q=` query param, itself set by a
   * rephrase/prefill link elsewhere. Adopted at mount via a lazy initializer and again, without a
   * remount, by the render-time check below. */
  initialQuestion?: string;
  /** Runs once `startQuestion()` resolves and the run has been seeded, so the page can refresh
   * its history list to pick up the new `queued` row. */
  onRunStarted?: () => void;
  /** Runs once per run when `answer.runStatus` reaches a terminal value (`completed` or
   * `failed`), so the page can refresh a history row that would otherwise sit at `queued`. */
  onRunSettled?: () => void;
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

// Static suggestions, not a recent-query history: a localStorage history would persist tenant
// content unscoped on a shared machine. They name no entity, because no entity name is common to
// every tenant — the Entity picker below carries the tenant's own names instead.
const EXAMPLE_QUESTIONS = [
  'What is the current occupancy rate across the portfolio?',
  'Are there any conflicting rent roll figures this quarter?',
];

export default function AnswerComposer({
  initialQuestion,
  onRunStarted,
  onRunSettled,
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

  const { pending, formError, cooldownSeconds, onSubmit, fieldProps } =
    useFormSubmit<'questionText'>({
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
  const {
    id: questionId,
    error: questionError,
    onBlur: questionOnBlur,
  } = fieldProps('questionText');

  // Refocuses the input once, when `formError` goes from none to an error. The trimmed-empty case
  // is covered by the hook's own scheduleFocus (see use-form-submit.ts); this covers the case it
  // leaves alone — a plain request failure, reported as `formError` with no field to focus. A 429
  // cooldown never refocuses: it rewrites `formError` every second while `cooldownSeconds` is
  // above 0, and focus stays wherever the operator moved it.
  const previousFormErrorRef = useRef<string | null>(null);
  useEffect(() => {
    const hadFormError = previousFormErrorRef.current !== null;
    previousFormErrorRef.current = formError;
    if (formError && !hadFormError && cooldownSeconds === 0) inputRef.current?.focus();
  }, [formError, cooldownSeconds]);

  function fillExample(example: string) {
    setQuestionText(example);
    inputRef.current?.focus();
  }

  // The tenant's own canonical entities, offered as a picker rather than baked into the example
  // chips, which every tenant shares. The endpoint takes no search term, so a tenant past 100
  // entities is offered the first alphabetical page.
  const [entityOptions, setEntityOptions] = useState<ComboboxOption[]>([]);
  const [entity, setEntity] = useState('');
  useAbortableEffect(
    (isCurrent) =>
      listCanonicalEntities({ limit: 100 })
        .then((result) => {
          if (!isCurrent()) return;
          setEntityOptions(
            result.docs.map((candidate) => ({
              value: candidate.canonicalName,
              label: candidate.canonicalName,
            })),
          );
        })
        .catch(() => {
          // Fails open: the picker is an aid to writing a question, never a gate on asking one,
          // so an unreachable list leaves the options empty and the question field usable.
        }),
    [],
  );

  // Appends the chosen name to the draft rather than replacing it, so a question written around
  // the entity survives the choice. A name already in the draft is not repeated.
  function insertEntity(canonicalName: string) {
    setEntity(canonicalName);
    setQuestionText((draft) => {
      if (draft.includes(canonicalName)) return draft;
      const trimmed = draft.trimEnd();
      return trimmed ? `${trimmed} ${canonicalName}` : canonicalName;
    });
    inputRef.current?.focus();
  }

  const {
    answer,
    error: runError,
    streamState,
  } = useAnswerRun({
    answerId,
    pollIntervalMs,
    initialAnswer: seedAnswer,
  });

  // Announces the outcome and notifies the page once per run, the moment `runStatus` reaches a
  // terminal value — keyed on id and status together so a later run reusing the same terminal
  // status still announces, and a re-render of the same terminal snapshot never announces twice.
  const settledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!answer) return;
    if (answer.runStatus !== 'completed' && answer.runStatus !== 'failed') return;
    const key = `${answer.id}:${answer.runStatus}`;
    if (settledKeyRef.current === key) return;
    settledKeyRef.current = key;
    announce(terminalAnnouncement(answer));
    onRunSettled?.();
  }, [answer, onRunSettled]);

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Ask a question</h2>
        </div>
        <form onSubmit={onSubmit} className="form" noValidate>
          {/* Its own control rather than a combobox over the question field: Enter asks, and a
              combobox on that input would take the key for option selection instead. */}
          <Combobox
            label="Entity"
            optional
            width="md"
            options={entityOptions}
            value={entity}
            onChange={insertEntity}
            placeholder="Add an entity to the question"
          />
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
              aria-busy={pending}
              className="composer-input"
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              onBlur={questionOnBlur}
              placeholder="Ask a question about your evidence"
              readOnly={pending}
            />
            <Button
              type="submit"
              variant="primary"
              className="composer-ask"
              busy={pending}
              busyLabel="Asking…"
            >
              Ask
            </Button>
          </div>
          {questionError && (
            <p id={`${questionId}-error`} className="field-error">
              <span className="sr-only">Error: </span>
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
                    <span className="btn-label">{example}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>
      </section>

      {formError && <Alert tone="rejected">{formError}</Alert>}

      {answer && <AnswerWorkspace answer={answer} variant="ask" streamState={streamState} />}

      {runError && (
        <p className="error" role="alert">
          {runError}
        </p>
      )}
    </>
  );
}
