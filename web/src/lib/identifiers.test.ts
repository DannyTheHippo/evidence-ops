import { describe, expect, it } from 'vitest';
import { shortId, truncateSha256, workflowTypeLabel } from './identifiers';

describe('workflowTypeLabel', () => {
  it('names each workflow type a run can carry', () => {
    expect(workflowTypeLabel('resolve-conflict')).toBe('Conflict resolution');
    expect(workflowTypeLabel('sync-source')).toBe('Source sync');
    expect(workflowTypeLabel('answer-question')).toBe('Question answering');
    expect(workflowTypeLabel('ingest-document-version')).toBe('Document ingest');
  });

  it('falls back to a generic label for a row written before the API recorded a type', () => {
    expect(workflowTypeLabel(undefined)).toBe('Workflow run');
  });
});

describe('truncateSha256', () => {
  it('keeps the head and tail of a full digest', () => {
    const digest = 'a'.repeat(8) + 'b'.repeat(52) + 'cdef';
    expect(truncateSha256(digest)).toBe('aaaaaaaa…cdef');
  });

  // Without the guard a short value truncates to head + a tail it already contains — 'chunk-1'
  // would render as 'chunk-1…nk-1'.
  it('returns a value too short to benefit unchanged', () => {
    expect(truncateSha256('chunk-1')).toBe('chunk-1');
    expect(truncateSha256('0123456789abc')).toBe('0123456789abc');
  });

  it('truncates as soon as doing so actually hides something', () => {
    expect(truncateSha256('0123456789abcd')).toBe('01234567…abcd');
  });
});

describe('shortId', () => {
  it('truncates an id long enough to be worth shortening', () => {
    expect(shortId('a3f1b2c4-5678-4d9e-9abc-1234567890ab')).toBe('a3f1b2c4…');
  });

  it('leaves a short id whole rather than adding an ellipsis that hides nothing', () => {
    expect(shortId('wf-1')).toBe('wf-1');
    expect(shortId('123456789012')).toBe('123456789012');
  });
});
