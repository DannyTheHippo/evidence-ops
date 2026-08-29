import { useEffect, useRef, useState } from 'react';
import type { AnswerRunStatus } from '../api/client';

type StagePhase = 'active' | 'exiting' | 'done';
type StageKey = 'queued' | 'answering' | 'result';
type MarkerState = 'filled' | 'pulsing' | 'outline';

interface RunStageStripProps {
  runStatus: AnswerRunStatus;
  /** ISO timestamp the run started from — the elapsed timer measures wall-clock against this,
   * never a value the strip invents itself. */
  startedAt: string;
  /** The sentence a screen reader hears in place of the visual strip, which carries no
   * `aria-live` region of its own: this is a progress ornament, and the run's actual outcome is
   * announced elsewhere. */
  description: string;
}

const STAGES: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: 'queued', label: 'Queued' },
  { key: 'answering', label: 'Answering' },
  { key: 'result', label: 'Result' },
];

function isInFlight(runStatus: AnswerRunStatus): boolean {
  return runStatus === 'queued' || runStatus === 'running';
}

/**
 * Every stage marker here comes from `runStatus` alone. The API exposes no per-stage telemetry —
 * no retrieval progress, no grounding progress — so a stage is only ever filled (reached),
 * pulsing (the one currently underway) or outline (not reached yet); nothing here implies a
 * percentage or a sub-stage the run does not actually report.
 */
function markerState(stage: StageKey, runStatus: AnswerRunStatus): MarkerState {
  if (stage === 'queued') return runStatus === 'queued' ? 'pulsing' : 'filled';
  if (stage === 'answering') {
    if (runStatus === 'queued') return 'outline';
    return runStatus === 'running' ? 'pulsing' : 'filled';
  }
  return isInFlight(runStatus) ? 'outline' : 'filled';
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Converts a CSS `<time>` value ("0.3s", "300ms") to milliseconds, or 0 for anything else — a
 * missing or unparsable value (no stylesheet loaded, as in a component test that renders this in
 * isolation) means "already there" rather than a broken wait. */
function parseCssDurationMs(raw: string): number {
  const trimmed = raw.trim();
  const value = parseFloat(trimmed);
  if (!Number.isFinite(value)) return 0;
  return trimmed.endsWith('ms') ? value : value * 1000;
}

/**
 * A horizontal Queued → Answering → Result strip standing in for the plain "Answering…" notices
 * `AnswerWorkspace` used to render inline for an in-flight run. Rotates `ProvenanceRail`'s
 * filled/pulsing/outline marker language horizontal, joined by a hairline connector, plus a mono
 * elapsed-time readout measured from `startedAt`.
 *
 * Manages its own exit: a run that transitions from in-flight to terminal keeps the strip mounted
 * long enough to cross-fade out via CSS, then removes it, so `.answer-outcome`'s own reveal is
 * never competing on screen with an abruptly-vanishing strip above it. A run that is already
 * terminal the first time this component mounts never renders at all — nothing here fakes a
 * progress sequence for a result that already exists.
 */
export default function RunStageStrip({ runStatus, startedAt, description }: RunStageStripProps) {
  const [phase, setPhase] = useState<StagePhase>(isInFlight(runStatus) ? 'active' : 'done');
  const wasInFlightRef = useRef(isInFlight(runStatus));
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - new Date(startedAt).getTime());

  useEffect(() => {
    const stillInFlight = isInFlight(runStatus);
    if (wasInFlightRef.current && !stillInFlight) setPhase('exiting');
    wasInFlightRef.current = stillInFlight;
  }, [runStatus]);

  // Reads the cross-fade's own duration from the design token rather than hardcoding a value that
  // could drift from it — `--motion-enter` is unset in a test that renders this component in
  // isolation with no stylesheet loaded, which resolves to 0 and removes the strip immediately
  // rather than hanging the test on a wait that will never end.
  useEffect(() => {
    if (phase !== 'exiting') return;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-enter');
    const timer = setTimeout(() => setPhase('done'), parseCssDurationMs(raw));
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'active') return;
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - new Date(startedAt).getTime());
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, startedAt]);

  if (phase === 'done') return null;

  return (
    <div className={`run-stage-strip${phase === 'exiting' ? ' run-stage-strip--exiting' : ''}`}>
      <span className="sr-only">{description}</span>
      <ol className="run-stage-list" aria-hidden="true">
        {STAGES.map((stage) => (
          <li
            key={stage.key}
            className={`run-stage run-stage--${markerState(stage.key, runStatus)}`}
          >
            <span className="run-stage-marker" />
            <span className="run-stage-label">{stage.label}</span>
          </li>
        ))}
      </ol>
      <span className="run-stage-timer mono" aria-hidden="true">
        {formatElapsed(elapsedMs)}
      </span>
    </div>
  );
}
