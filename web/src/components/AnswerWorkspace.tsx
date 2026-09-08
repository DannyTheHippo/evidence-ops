import type { Answer } from '../api/client';
import { answerBadge } from '../lib/answer-status';
import { useAnswerEnrichment } from '../lib/use-answer-enrichment';
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
   * duplicate it). The two variants also carry different sr-only text for `RunStageStrip`,
   * describing the same in-flight state each reader already sees visually.
   */
  variant: 'ask' | 'detail';
}

/**
 * The answer surface shared by AnswerComposer's live view and AnswerDetailPage's historical view:
 * the status badge, the in-flight and failed notices, `AnswerView`'s outcome rendering, and —
 * admin only — the run's model cost. Reads its own session rather than taking `isAdmin` as a
 * prop, so neither caller has to thread it through.
 */
export default function AnswerWorkspace({ answer, variant }: AnswerWorkspaceProps) {
  const session = useSession();
  const isAdmin = session.status === 'authed' && session.me.role === 'admin';
  const { documentIndex, conflictChunkIndex } = useAnswerEnrichment(answer);
  const isInFlight = answer.runStatus === 'queued' || answer.runStatus === 'running';
  const badge = answerBadge(answer);

  return (
    <section className="card">
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
          variant === 'ask' ? 'Answering…' : 'Still answering — check back once this run completes.'
        }
      />

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
