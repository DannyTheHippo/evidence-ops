import { describe, expect, it } from 'vitest';
import type { Source } from '../api/client';
import { sourceStatus } from './source-status';

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'source-1',
    name: 'Deal Room Inbox',
    kind: 'local-folder',
    path: 'deal-room',
    enabled: true,
    fileCount: 3,
    connectivity: 'connector',
    reachability: 'live',
    owner: 'Jane Doe, IT',
    tracked: true,
    sourceClass: 'unclassified',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sourceStatus', () => {
  it('reports mcp-submit for a source of that kind, even while tracked, enabled and synced', () => {
    const status = sourceStatus(makeSource({ kind: 'mcp-submit', lastSyncStatus: 'ok' }), false);
    expect(status).toMatchObject({ key: 'mcp-submit', tone: 'info' });
  });

  it('reports untracked for a catalogued-only source, even while enabled and synced', () => {
    const status = sourceStatus(makeSource({ tracked: false, lastSyncStatus: 'ok' }), false);
    expect(status).toMatchObject({ key: 'untracked', tone: 'neutral' });
  });

  it('reports disabled for a tracked source with the loop turned off, even mid-poll', () => {
    const status = sourceStatus(makeSource({ enabled: false }), true);
    expect(status).toMatchObject({ key: 'disabled', tone: 'neutral' });
  });

  it('reports syncing while a sweep is in progress, ahead of the last outcome', () => {
    const status = sourceStatus(makeSource({ lastSyncStatus: 'failed' }), true);
    expect(status).toMatchObject({ key: 'syncing', tone: 'info' });
  });

  it('reports failed with the carried error as detail', () => {
    const status = sourceStatus(
      makeSource({ lastSyncStatus: 'failed', lastSyncError: 'ENOENT: no such file or directory' }),
      false,
    );
    expect(status).toMatchObject({
      key: 'failed',
      tone: 'caution',
      detail: 'ENOENT: no such file or directory',
    });
  });

  it('reports ok for a source whose last sweep succeeded', () => {
    const status = sourceStatus(makeSource({ lastSyncStatus: 'ok' }), false);
    expect(status).toMatchObject({ key: 'ok', tone: 'verified' });
  });

  it('reports pending for a tracked, enabled source before its first sweep', () => {
    const status = sourceStatus(makeSource({ lastSyncStatus: undefined }), false);
    expect(status).toEqual({
      key: 'pending',
      tone: 'neutral',
      label: 'Not synced yet',
      detail: 'Waiting for the first sweep',
    });
  });
});
