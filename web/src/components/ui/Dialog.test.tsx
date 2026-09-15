import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dialog from './Dialog';

// jsdom runs no layout, so every element reports an empty box; this gives the dialog a 400×300 box
// at (100, 100).
function stubDialogBox(dialog: HTMLElement) {
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 300));
}

// Holds a node that was never attached, standing in for a fallback removed with its row.
const detachedFallbackRef = { current: document.createElement('div') };

// A page with a heading, an optional Delete opener and a focusable Row, whose dialog's
// `fallbackFocusRef` points at the Row, at a detached node, or at nothing.
function FocusFixture({
  open,
  showOpener,
  fallback,
}: {
  open: boolean;
  showOpener: boolean;
  fallback: 'live' | 'detached' | 'none';
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const fallbackFocusRef = { live: rowRef, detached: detachedFallbackRef, none: undefined }[
    fallback
  ];
  return (
    <main id="main-content">
      <h1 tabIndex={-1}>Documents</h1>
      {showOpener && <button>Delete</button>}
      <div ref={rowRef} tabIndex={-1}>
        Row
      </div>
      <Dialog
        open={open}
        onClose={() => {}}
        title="Delete document"
        fallbackFocusRef={fallbackFocusRef}
      >
        <p>Irreversible.</p>
      </Dialog>
    </main>
  );
}

describe('Dialog', () => {
  it('resolves by role and title when open', () => {
    render(
      <Dialog open onClose={() => {}} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Delete document' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('calls onClose when the dialog fires its native close event', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Delete document' });
    dialog.dispatchEvent(new Event('close'));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('defaults to the medium size', () => {
    render(
      <Dialog open onClose={() => {}} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Delete document' })).toHaveClass('dialog--md');
  });

  it('applies the requested size modifier', () => {
    render(
      <Dialog open onClose={() => {}} title="Delete document" size="lg">
        <p>Irreversible.</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Delete document' })).toHaveClass('dialog--lg');
  });

  it('closes on the header close control', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on a backdrop pointer press', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    // A backdrop press targets the <dialog> element itself at a point outside its box.
    const dialog = screen.getByRole('dialog', { name: 'Delete document' });
    stubDialogBox(dialog);
    fireEvent.pointerDown(dialog, { clientX: 40, clientY: 40 });
    fireEvent.pointerUp(dialog, { clientX: 40, clientY: 40 });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open on a press inside its own padding', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    // The padding band belongs to the <dialog> element, so a press there targets the dialog
    // itself while its coordinates fall inside the dialog's box.
    const dialog = screen.getByRole('dialog', { name: 'Delete document' });
    stubDialogBox(dialog);
    fireEvent.pointerDown(dialog, { clientX: 110, clientY: 390 });
    fireEvent.pointerUp(dialog, { clientX: 110, clientY: 390 });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves a click inside the dialog alone', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    fireEvent.pointerDown(screen.getByText('Irreversible.'));

    expect(onClose).not.toHaveBeenCalled();
  });

  describe('focus on close', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('restores focus to an opener still in the document', () => {
      const { rerender } = render(<FocusFixture open={false} showOpener fallback="live" />);
      const opener = screen.getByRole('button', { name: 'Delete' });
      opener.focus();
      rerender(<FocusFixture open showOpener fallback="live" />);

      rerender(<FocusFixture open={false} showOpener fallback="live" />);

      expect(opener).toHaveFocus();
    });

    it.each([
      { atOpen: 'body', activeElement: () => document.body },
      { atOpen: 'no element', activeElement: () => null },
    ])('moves no focus on close when $atOpen held focus at open', ({ activeElement }) => {
      const { rerender } = render(<FocusFixture open={false} showOpener={false} fallback="live" />);
      const activeAtOpen = vi
        .spyOn(Document.prototype, 'activeElement', 'get')
        .mockReturnValue(activeElement());
      rerender(<FocusFixture open showOpener={false} fallback="live" />);
      activeAtOpen.mockRestore();
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');

      rerender(<FocusFixture open={false} showOpener={false} fallback="live" />);

      expect(focus).not.toHaveBeenCalled();
      expect(document.body).toHaveFocus();
    });

    it.each([
      { fallback: 'live', target: () => screen.getByText('Row') },
      { fallback: 'detached', target: () => screen.getByRole('heading', { level: 1 }) },
      { fallback: 'none', target: () => screen.getByRole('heading', { level: 1 }) },
    ] as const)(
      'focuses the next target without scrolling when the opener has left the document and the fallback is $fallback',
      ({ fallback, target }) => {
        const { rerender } = render(<FocusFixture open={false} showOpener fallback={fallback} />);
        screen.getByRole('button', { name: 'Delete' }).focus();
        rerender(<FocusFixture open showOpener fallback={fallback} />);
        const focus = vi.spyOn(target(), 'focus');

        rerender(<FocusFixture open={false} showOpener={false} fallback={fallback} />);

        expect(target()).toHaveFocus();
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      },
    );

    it('leaves focus on a live element outside the dialog when the opener has left the document', () => {
      const { rerender } = render(<FocusFixture open={false} showOpener fallback="none" />);
      screen.getByRole('button', { name: 'Delete' }).focus();
      rerender(<FocusFixture open showOpener fallback="none" />);
      screen.getByText('Row').focus();

      rerender(<FocusFixture open={false} showOpener={false} fallback="none" />);

      expect(screen.getByText('Row')).toHaveFocus();
    });
  });

  it('honours initialFocusRef over the native default', () => {
    function Fixture() {
      const targetRef = useRef<HTMLButtonElement>(null);
      return (
        <Dialog open onClose={() => {}} title="Delete document" initialFocusRef={targetRef}>
          <button>First</button>
          <button ref={targetRef}>Target</button>
        </Dialog>
      );
    }
    render(<Fixture />);

    expect(screen.getByRole('button', { name: 'Target' })).toHaveFocus();
  });
});
