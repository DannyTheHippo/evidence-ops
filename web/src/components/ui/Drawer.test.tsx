import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Drawer from './Drawer';

// Stubs `window.matchMedia` with a query object whose 'change' listener a test can fire directly —
// jsdom implements no matchMedia at all, real browsers always carry it.
function stubMatchMedia() {
  let listener: ((event: MediaQueryListEvent) => void) | null = null;
  const query = {
    matches: false,
    media: '(min-width: 768px)',
    addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => {
      listener = cb;
    },
    removeEventListener: () => {
      listener = null;
    },
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(query));
  return {
    widen: () => listener?.({ matches: true } as MediaQueryListEvent),
  };
}

// jsdom runs no layout, so every element reports an empty box; this gives the sheet a full-height
// 400px-wide box at the end edge of an 1100×600 viewport.
function stubSheetBox(dialog: HTMLElement) {
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(700, 0, 400, 600));
}

describe('Drawer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the sheet by its title', () => {
    render(
      <Drawer open onClose={() => {}} title="Navigation">
        <p>Links</p>
      </Drawer>,
    );

    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();
  });

  it('closes on Escape, the close control and the backdrop', () => {
    const onEscapeClose = vi.fn();
    const { unmount: unmountEscape } = render(
      <Drawer open onClose={onEscapeClose} title="Navigation">
        <p>Links</p>
      </Drawer>,
    );
    screen.getByRole('dialog', { name: 'Navigation' }).dispatchEvent(new Event('close'));
    expect(onEscapeClose).toHaveBeenCalledOnce();
    unmountEscape();

    const onCloseControlClose = vi.fn();
    const { unmount: unmountControl } = render(
      <Drawer open onClose={onCloseControlClose} title="Navigation">
        <p>Links</p>
      </Drawer>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCloseControlClose).toHaveBeenCalledOnce();
    unmountControl();

    const onBackdropClose = vi.fn();
    render(
      <Drawer open onClose={onBackdropClose} title="Navigation">
        <p>Links</p>
      </Drawer>,
    );
    const backdropDialog = screen.getByRole('dialog', { name: 'Navigation' });
    stubSheetBox(backdropDialog);
    fireEvent.pointerDown(backdropDialog, { clientX: 20, clientY: 300 });
    fireEvent.pointerUp(backdropDialog, { clientX: 20, clientY: 300 });
    expect(onBackdropClose).toHaveBeenCalledOnce();
  });

  it('stays open on a press inside its own padding', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Navigation">
        <p>Links</p>
      </Drawer>,
    );

    // The padding band belongs to the <dialog> element, so a press there targets the sheet itself
    // while its coordinates fall inside the sheet's box.
    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    stubSheetBox(dialog);
    fireEvent.pointerDown(dialog, { clientX: 710, clientY: 590 });
    fireEvent.pointerUp(dialog, { clientX: 710, clientY: 590 });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes itself when the viewport widens past the breakpoint', () => {
    const { widen } = stubMatchMedia();
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Navigation" closeOnWiden>
        <p>Links</p>
      </Drawer>,
    );

    widen();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('leaves focus and scroll alone on close when no element held focus at open', () => {
    const page = (open: boolean) => (
      <main id="main-content">
        <h1 tabIndex={-1}>Ledger</h1>
        <Drawer open={open} onClose={() => {}} title="Facts">
          <p>Values</p>
        </Drawer>
      </main>
    );
    const { rerender } = render(page(true));
    const focus = vi.spyOn(screen.getByRole('heading', { level: 1 }), 'focus');

    rerender(page(false));

    expect(focus).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
  });

  it('renders visibly where showModal is absent', () => {
    // jsdom implements neither showModal() nor close(): the drawer fails OPEN, exactly as
    // Dialog does, rendering its content rather than throwing or staying invisible.
    render(
      <Drawer open onClose={() => {}} title="Navigation">
        <p>Links</p>
      </Drawer>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Links')).toBeInTheDocument();
  });
});
