import type { BadgeTone } from '../components/ui/Badge';
import type { Source } from '../api/client';

export type SourceStatusKey =
  'mcp-submit' | 'untracked' | 'disabled' | 'syncing' | 'failed' | 'ok' | 'pending';

export interface SourceStatus {
  key: SourceStatusKey;
  tone: BadgeTone;
  label: string;
  detail?: string;
}

/**
 * Resolves a source's status from `kind`, `tracked`, `enabled`, `lastSyncStatus` and
 * `lastSyncError`; it ignores `lastSyncAt` and the richer `lastSync` object.
 *
 * The checks run in priority order because each one makes the rest moot: an `mcp-submit` source
 * never runs the sync loop at all, so nothing past `kind` applies to it; an untracked source is
 * catalogued only, so its `enabled` flag describes nothing; a disabled source's last outcome is
 * frozen, so an in-flight sweep or a stale error would both be misleading; and a sweep in progress
 * outranks whatever the previous one left behind. `pending` is the seventh, additive case: a
 * tracked, enabled source before its first sweep, where `lastSyncStatus` is simply absent rather
 * than naming an outcome.
 */
export function sourceStatus(source: Source, isPolling: boolean): SourceStatus {
  if (source.kind === 'mcp-submit') {
    return {
      key: 'mcp-submit',
      tone: 'info',
      label: 'MCP submission',
      detail: 'Evidence arrives through the MCP surface; no sync loop runs.',
    };
  }
  if (!source.tracked) {
    return {
      key: 'untracked',
      tone: 'neutral',
      label: 'Catalogued only',
      detail: 'Not synced by a connector.',
    };
  }
  if (!source.enabled) {
    return {
      key: 'disabled',
      tone: 'neutral',
      label: 'Disabled',
      detail: 'The sync loop is turned off.',
    };
  }
  if (isPolling) {
    return { key: 'syncing', tone: 'info', label: 'Syncing', detail: 'A sweep is in progress.' };
  }
  if (source.lastSyncStatus === 'failed') {
    return { key: 'failed', tone: 'caution', label: 'Sync failed', detail: source.lastSyncError };
  }
  if (source.lastSyncStatus === 'ok') {
    return { key: 'ok', tone: 'verified', label: 'Synced' };
  }
  return {
    key: 'pending',
    tone: 'neutral',
    label: 'Not synced yet',
    detail: 'Waiting for the first sweep',
  };
}
