import type { Answer } from '../api/client';
import { answerBadge } from '../lib/answer-status';
import { useAnswerEnrichment } from '../lib/use-answer-enrichment';
import { CONNECTION_LABELS, CONNECTION_TONES, type StreamState } from '../lib/use-event-stream';
import { useSession } from '../lib/use-session';
import AnswerView from './AnswerView';
import RunStageStrip from './RunStageStrip';
import Badge from './ui/Badge';
import DescriptionList from './ui/DescriptionList';
import Skeleton from './ui/Skeleton';

interface AnswerWorkspaceProps {
  answer: Answer;
  /**
   * 'ask' repeats the question as the card's own heading, since AnswerComposer sits under the
   * static "Answers" page title rather than the question, and shows a full skeleton while in
   * flight — there is nothing else on the page yet for a reader to look at. 'detail' leaves the
   * heading to the page's own title (already the question text, so a second copy here would
   * duplicate it), so it renders its own visually-hidden `h2` instead, keeping the sections below
   * from sitting directly under the page's `h1`. The two variants also carry different sr-only
   * text for `RunStageStrip`, describing the same in-flight state each reader already sees
   * visually.
   */
  variant: 'ask' | 'detail';
  /**
   * The transport carrying this run, from `useAnswerRun`. Optional and additive: a caller with no
   * stream to report renders no connection line at all, and a terminal run never shows one either
   * — a finished run needs no transport story. Never sourced from anywhere but the shared
   * `CONNECTION_LABELS` vocabulary, so this line can never claim "live" while the stream is stale.
   */
  streamState?: StreamState;
}

/**
 * The answer surface shared by AnswerComposer's live view and AnswerDetailPage's historical view:
 * the status badge, the in-flight and failed notices, `AnswerView`'s outcome rendering, and —
 * admin only — the run's model cost. Reads its own session rather than taking `isAdmin` as a
 * prop, so neither caller has to thread it through.
 */
export default function AnswerWorkspace({ answer, variant, streamState }: AnswerWorkspaceProps) {
  const session = useSession();
  const isAdmin = session.status === 'authed' && session.me.role === 'admin';
  const { documentIndex, conflictChunkIndex } = useAnswerEnrichment(answer);
  const isInFlight = answer.runStatus === 'queued' || answer.runStatus === 'running';
  const badge = answerBadge(answer);
  const tone = streamState ? CONNECTION_TONES[streamState] : undefined;

  return (
    <section className="card">
      {variant === 'detail' && <h2 className="sr-only">Answer</h2>}
      <div className="card-head">
        {variant === 'ask' && <h2 className="card-title">{answer.questionText}</h2>}
        <Badge tone={badge.tone}>
          {isInFlight && <span className="live-dot" />}
          {badge.label}
        </Badge>
      </div>

      <RunStageStrip
        runStatus={answer.runStatus}
        startedAt={answer.createdAt}
        description={
          variant === 'ask'
            ? 'Answering…'
            : 'Still answering — this page updates as the run progresses.'
        }
      />

      {isInFlight && streamState && (
        <div className="answers-connection">
          <span
            className={tone ? `connection-dot connection-dot--${tone}` : 'connection-dot'}
            aria-hidden="true"
          />
          <span className="micro-label">{CONNECTION_LABELS[streamState].label}</span>
          <span className="sr-only">. {CONNECTION_LABELS[streamState].detail}</span>
        </div>
      )}

      {isInFlight && variant === 'ask' && (
        // The outcome arrives as one atomic snapshot, never incrementally, so this stands
        // in for the ledger and apparatus rows rather than filling progressively.
        <Skeleton label="Answering…" lines={6} />
      )}

      {answer.runStatus === 'failed' && (
        <p className="error" role="alert">
          The question run failed.
        </p>
      )}

      <AnswerView
        answer={answer}
        documentIndex={documentIndex}
        conflictChunkIndex={conflictChunkIndex}
      />

      {isAdmin && answer.usage && (
        <div className="run-cost-footer">
          <DescriptionList
            items={[
              {
                term: 'Run cost',
                description: <span className="mono">{`$${answer.usage.costUsd.toFixed(4)}`}</span>,
              },
            ]}
          />
        </div>
      )}
    </section>
  );
}
