import { describe, expect, it } from 'vitest';
import {
  approvalStateForOutcome,
  runOutcomeView,
  runStatusView,
  runTypeCanPark,
  runWorkStepLabel,
} from './run-status';

describe('runStatusView', () => {
  it('maps every WorkflowRunStatus to its label and tone', () => {
    expect(runStatusView('queued')).toEqual({ tone: 'neutral', label: 'Queued' });
    expect(runStatusView('running')).toEqual({ tone: 'info', label: 'Running' });
    expect(runStatusView('completed')).toEqual({ tone: 'verified', label: 'Completed' });
    expect(runStatusView('failed')).toEqual({ tone: 'rejected', label: 'Failed' });
  });
});

describe('runOutcomeView', () => {
  it('maps every WorkflowRunOutcome to its label and tone', () => {
    expect(runOutcomeView('resolved')).toEqual({ tone: 'verified', label: 'Resolved' });
    expect(runOutcomeView('rejected')).toEqual({ tone: 'caution', label: 'Rejected' });
    expect(runOutcomeView('timed_out')).toEqual({
      tone: 'caution',
      label: 'Approval timed out',
    });
  });
});

describe('runTypeCanPark', () => {
  it('answers true for the types that request a human approval', () => {
    expect(runTypeCanPark('resolve-conflict')).toBe(true);
    expect(runTypeCanPark('ingest-document-version')).toBe(true);
  });

  it('answers true for an undefined type, so an unknown shape keeps its approval step', () => {
    expect(runTypeCanPark(undefined)).toBe(true);
  });

  it('answers false for the types that never park', () => {
    expect(runTypeCanPark('sync-source')).toBe(false);
    expect(runTypeCanPark('answer-question')).toBe(false);
    expect(runTypeCanPark('rescan-conflicts')).toBe(false);
  });
});

describe('runWorkStepLabel', () => {
  it('names the in-flight work step for each two-step type', () => {
    expect(runWorkStepLabel('sync-source')).toBe('Syncing');
    expect(runWorkStepLabel('answer-question')).toBe('Answering');
    expect(runWorkStepLabel('rescan-conflicts')).toBe('Rescanning');
  });

  it('falls back to Working for a three-step type or an undefined type', () => {
    expect(runWorkStepLabel('resolve-conflict')).toBe('Working');
    expect(runWorkStepLabel('ingest-document-version')).toBe('Working');
    expect(runWorkStepLabel(undefined)).toBe('Working');
  });
});

describe('approvalStateForOutcome', () => {
  it('maps a terminal outcome to the approval state that decided it', () => {
    expect(approvalStateForOutcome('resolved')).toBe('approved');
    expect(approvalStateForOutcome('rejected')).toBe('rejected');
    expect(approvalStateForOutcome('timed_out')).toBe('timed_out');
  });
});
