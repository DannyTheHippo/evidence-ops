import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  announce,
  clearAnnouncements,
  subscribeAnnouncements,
  unsubscribeAnnouncements,
} from './announce';

describe('announce', () => {
  afterEach(() => {
    clearAnnouncements();
  });

  it('fans a message out to every subscribed listener', () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeAnnouncements(first);
    subscribeAnnouncements(second);

    announce('Sources · Evidence Ops');

    expect(first).toHaveBeenCalledWith('Sources · Evidence Ops');
    expect(second).toHaveBeenCalledWith('Sources · Evidence Ops');
  });

  it('fans out an identical repeat rather than deduplicating it', () => {
    const listener = vi.fn();
    subscribeAnnouncements(listener);

    announce('Saved.');
    announce('Saved.');

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const listener = vi.fn();
    subscribeAnnouncements(listener);
    unsubscribeAnnouncements(listener);

    announce('Saved.');

    expect(listener).not.toHaveBeenCalled();
  });

  it('clears every listener on clearAnnouncements', () => {
    const listener = vi.fn();
    subscribeAnnouncements(listener);
    clearAnnouncements();

    announce('Saved.');

    expect(listener).not.toHaveBeenCalled();
  });
});
