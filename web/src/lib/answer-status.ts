import type { BadgeTone } from '../components/ui/Badge';
import type { Answer, AnswerRunStatus } from '../api/client';

/** The tone each non-terminal run status carries. `completed` is absent by construction: a
 * completed answer is described by its outcome, which `answerBadge` resolves instead. */
export const RUN_STATUS_TONE: Record<Exclude<AnswerRunStatus, 'completed'>, BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  failed: 'rejected',
};

/** Resolves the badge tone and label for an answer, whatever stage it is at.
 *
 * The label is lowercase because every status label in this SPA is; the badge is a status marker,
 * not a title. Returning the pair rather than a rendered `Badge` keeps this a data mapping, which
 * is what lets it live here — and gives the vocabulary one definition instead of one per page.
 *
 * All three completed outcomes are equally valid results: `insufficient_evidence` is an honest
 * abstention rather than a failure, so it carries `info` and never a reject tone. Only a
 * `failed` run status is a failure. */
export function answerBadge(answer: Answer): { tone: BadgeTone; label: string } {
  if (answer.runStatus !== 'completed') {
    return { tone: RUN_STATUS_TONE[answer.runStatus], label: answer.runStatus };
  }

  switch (answer.outcome?.kind) {
    case 'answered':
      return { tone: 'verified', label: 'answered' };
    case 'conflicting_evidence':
      return { tone: 'caution', label: 'conflicting evidence' };
    case 'insufficient_evidence':
      return { tone: 'info', label: 'insufficient evidence' };
    default:
      // A completed answer with no outcome is not a shape the API produces; falling back to the
      // run status keeps the badge truthful rather than asserting a result that was never written.
      return { tone: 'neutral', label: answer.runStatus };
  }
}
