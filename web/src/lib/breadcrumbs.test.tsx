import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBreadcrumbTrail,
  subscribeBreadcrumbs,
  unsubscribeBreadcrumbs,
  useBreadcrumbs,
  useBreadcrumbTrail,
  type BreadcrumbItem,
} from './breadcrumbs';

function Publisher({ trail }: { trail: BreadcrumbItem[] }) {
  useBreadcrumbs(trail);
  return null;
}

function Reader({ fallback }: { fallback: BreadcrumbItem[] }) {
  const trail = useBreadcrumbTrail(fallback);
  return <p>trail: {trail.map((item) => item.label).join(' > ')}</p>;
}

// Tracked so a listener a test subscribes mid-run is always unsubscribed, even on assertion
// failure — an orphaned listener would keep firing into later tests that share this module's
// trail channel, mirroring `use-event-stream.test.tsx`'s `trackedStatusListeners`.
const trackedListeners: Array<(trail: BreadcrumbItem[]) => void> = [];

function trackListener(
  listener: (trail: BreadcrumbItem[]) => void,
): (trail: BreadcrumbItem[]) => void {
  trackedListeners.push(listener);
  subscribeBreadcrumbs(listener);
  return listener;
}

describe('useBreadcrumbs', () => {
  afterEach(() => {
    for (const listener of trackedListeners.splice(0)) {
      unsubscribeBreadcrumbs(listener);
    }
  });

  it('publishes the trail on mount and clears it back to empty on unmount', () => {
    const { unmount } = render(<Publisher trail={[{ label: 'Sources' }]} />);
    expect(getBreadcrumbTrail()).toEqual([{ label: 'Sources' }]);

    unmount();
    expect(getBreadcrumbTrail()).toEqual([]);
  });

  it('caps a four-level trail to three, dropping the excess rather than the Section', () => {
    const { unmount } = render(
      <Publisher
        trail={[
          { label: 'Evidence' },
          { label: 'Sources', to: '/sources' },
          { label: 'Acme Tower' },
          { label: 'Extra' },
        ]}
      />,
    );

    expect(getBreadcrumbTrail()).toEqual([
      { label: 'Evidence' },
      { label: 'Sources', to: '/sources' },
      { label: 'Acme Tower' },
    ]);
    unmount();
  });

  it('republishes only when the trail content changes, not on every render passing a fresh array literal', () => {
    const listener = trackListener(vi.fn());

    const { rerender, unmount } = render(<Publisher trail={[{ label: 'Sources' }]} />);
    expect(listener).toHaveBeenCalledTimes(1);

    // A new array literal, identical content — the call shape every real page uses. Keying the
    // effect on identity here would republish on this render too.
    rerender(<Publisher trail={[{ label: 'Sources' }]} />);
    expect(listener).toHaveBeenCalledTimes(1);

    rerender(<Publisher trail={[{ label: 'Sources' }, { label: 'Acme Tower' }]} />);
    expect(listener).toHaveBeenCalledTimes(2);

    unmount();
  });
});

describe('useBreadcrumbTrail', () => {
  it('falls back to the given fallback while nothing has published a trail', () => {
    render(<Reader fallback={[{ label: 'Sources' }]} />);
    expect(screen.getByText('trail: Sources')).toBeInTheDocument();
  });

  it('reads the live trail once a page publishes one, and falls back again once it unmounts', () => {
    function Scene({ showPublisher }: { showPublisher: boolean }) {
      return (
        <>
          {showPublisher && <Publisher trail={[{ label: 'Sources' }, { label: 'Acme Tower' }]} />}
          <Reader fallback={[{ label: 'Sources' }]} />
        </>
      );
    }

    const { rerender } = render(<Scene showPublisher={false} />);
    expect(screen.getByText('trail: Sources')).toBeInTheDocument();

    rerender(<Scene showPublisher />);
    expect(screen.getByText('trail: Sources > Acme Tower')).toBeInTheDocument();

    rerender(<Scene showPublisher={false} />);
    expect(screen.getByText('trail: Sources')).toBeInTheDocument();
  });
});
