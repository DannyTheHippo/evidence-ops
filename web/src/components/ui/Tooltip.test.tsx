import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Tooltip from './Tooltip';

describe('Tooltip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on focus and links the anchor by aria-describedby', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Copies the API key to the clipboard.">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    const anchor = screen.getByRole('button', { name: 'Copy' });
    anchor.focus();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    const surface = screen.getByRole('tooltip');
    expect(anchor).toHaveAttribute('aria-describedby', surface.id);
    expect(surface).toHaveTextContent('Copies the API key to the clipboard.');
  });

  it('opens after the delay on pointer enter', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Copies the API key to the clipboard.">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    fireEvent.pointerOver(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('stays open while the surface itself is hovered', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Copies the API key to the clipboard.">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    const anchor = screen.getByRole('button', { name: 'Copy' });
    fireEvent.pointerOver(anchor);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const surface = screen.getByRole('tooltip');

    // Moving off the anchor onto the surface stays within the shared container — relatedTarget is
    // the surface, so this does not close the tooltip.
    fireEvent.pointerOut(anchor, { relatedTarget: surface });

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('stays open while the pointer crosses the gap between the anchor and the surface', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Copies the API key to the clipboard.">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    const anchor = screen.getByRole('button', { name: 'Copy' });
    fireEvent.pointerOver(anchor);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // Leaving into the placement gap itself, not onto the surface — relatedTarget is neither the
    // anchor nor the surface — starts the close grace window rather than closing immediately.
    fireEvent.pointerOut(anchor, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // Landing on the surface within the grace window cancels the pending close.
    fireEvent.pointerOver(screen.getByRole('tooltip'));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('closes after the grace window when the pointer never lands back on the anchor or surface', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Copies the API key to the clipboard.">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    const anchor = screen.getByRole('button', { name: 'Copy' });
    fireEvent.pointerOver(anchor);
    act(() => {
      vi.advanceTimersByTime(300);
    });

    fireEvent.pointerOut(anchor, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses on Escape from anywhere in the document while open, without moving focus', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Copies the API key to the clipboard.">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    const anchor = screen.getByRole('button', { name: 'Copy' });
    fireEvent.pointerOver(anchor);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses on Escape without moving focus', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Copies the API key to the clipboard.">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    const anchor = screen.getByRole('button', { name: 'Copy' });
    anchor.focus();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(anchor, { key: 'Escape' });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(anchor).toHaveFocus();
  });

  it('still opens on its original schedule, with the latest content, when content changes during the open delay', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <Tooltip content="0.061">
        <button type="button">Value</button>
      </Tooltip>,
    );

    screen.getByRole('button', { name: 'Value' }).focus();
    act(() => {
      vi.advanceTimersByTime(150);
    });

    rerender(
      <Tooltip content="0.061 ratio">
        <button type="button">Value</button>
      </Tooltip>,
    );
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('0.061 ratio');
  });

  it('still closes when content changes during the close grace window', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <Tooltip content="0.061">
        <button type="button">Value</button>
      </Tooltip>,
    );

    const anchor = screen.getByRole('button', { name: 'Value' });
    fireEvent.pointerOver(anchor);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.pointerOut(anchor, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender(
      <Tooltip content="0.061 ratio">
        <button type="button">Value</button>
      </Tooltip>,
    );
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes when a focusout reaches the listener closure captured before the tooltip opened', () => {
    vi.useFakeTimers();
    const addSpy = vi.spyOn(HTMLSpanElement.prototype, 'addEventListener');
    render(
      <Tooltip content="Copies the API key to the clipboard.">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    // The anchor span's first `focusout` listener is registered while the tooltip is still
    // closed. Capturing it here and invoking it directly, after the tooltip has since opened,
    // stands in for a native event that lands on this same stale closure in the gap between the
    // open commit and the passive listener effect's re-subscription — a gap `act`/`flushSync`
    // both close before returning control to this test, so a dispatched event cannot land there.
    const [, staleHandleFocusOut] = addSpy.mock.calls.find(([type]) => type === 'focusout')!;
    addSpy.mockRestore();

    const anchor = screen.getByRole('button', { name: 'Copy' });
    anchor.focus();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    (staleHandleFocusOut as EventListener)(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes on a pointerout landing between the open timer firing and React committing it', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Copies the API key to the clipboard.">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    const anchor = screen.getByRole('button', { name: 'Copy' });
    fireEvent.pointerOver(anchor);

    // A single `act` callback defers its flush to the callback's exit, so the native pointerout
    // dispatched here lands after the open timer's callback has run (the ref write is requested)
    // but before React has committed the resulting state — the same gap a real browser event can
    // land in between the timer firing and the next paint.
    act(() => {
      vi.advanceTimersByTime(300);
      anchor.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
      );
    });
    // The open commits after the pointerout was handled, proving the event landed in the gap
    // rather than after the close was already scheduled.
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('renders the child unwrapped with no content', () => {
    const { container } = render(
      <Tooltip content="">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    expect(container.querySelector('.tooltip-anchor')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).not.toHaveAttribute('aria-describedby');
  });
});
