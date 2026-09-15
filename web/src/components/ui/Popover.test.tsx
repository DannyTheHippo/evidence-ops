import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Popover from './Popover';

function renderOpenPopover(placement: 'bottom-start' | 'bottom-end' = 'bottom-start') {
  render(
    <Popover
      trigger={<button type="button">Open</button>}
      open
      onOpenChange={vi.fn()}
      label="Options"
      placement={placement}
    >
      <p>Content</p>
    </Popover>,
  );
  const surfaceId = screen.getByRole('button', { name: 'Open' }).getAttribute('aria-controls');
  return document.getElementById(surfaceId!)!;
}

describe('Popover', () => {
  it('wires aria-expanded and aria-controls on the trigger', () => {
    render(
      <Popover
        trigger={<button type="button">Open</button>}
        open
        onOpenChange={vi.fn()}
        label="Options"
      >
        <p>Content</p>
      </Popover>,
    );

    const trigger = screen.getByRole('button', { name: 'Open' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const surfaceId = trigger.getAttribute('aria-controls');
    expect(surfaceId).toBeTruthy();
    expect(document.getElementById(surfaceId!)).toBeInTheDocument();
  });

  it('names the surface', () => {
    render(
      <Popover
        trigger={<button type="button">Open</button>}
        open
        onOpenChange={vi.fn()}
        label="Options"
      >
        <p>Content</p>
      </Popover>,
    );

    const surfaceId = screen.getByRole('button', { name: 'Open' }).getAttribute('aria-controls');
    expect(document.getElementById(surfaceId!)).toHaveAttribute('aria-label', 'Options');
  });

  it('renders the surface where showPopover is absent', () => {
    render(
      <Popover
        trigger={<button type="button">Open</button>}
        open
        onOpenChange={vi.fn()}
        label="Options"
      >
        <p>Content</p>
      </Popover>,
    );

    // jsdom implements neither showPopover() nor CSS anchor positioning: this confirms the
    // fail-open result (the surface renders visibly) — real-browser placement is unexercised here.
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  // jsdom has no popover API, so these install one on the prototype to model a browser that
  // implements `popover` and differs only in CSS anchor positioning support.
  describe('where the popover API exists', () => {
    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    const originalShow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover');
    const originalHide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover');

    function restore(name: 'showPopover' | 'hidePopover', original?: PropertyDescriptor) {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, name, original);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>)[name];
      }
    }

    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'showPopover', {
        configurable: true,
        value: showPopover,
      });
      Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
        configurable: true,
        value: hidePopover,
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      showPopover.mockReset();
      hidePopover.mockReset();
      restore('showPopover', originalShow);
      restore('hidePopover', originalHide);
    });

    it('renders the surface in place, without the popover attribute, where CSS anchor positioning is unsupported', () => {
      const supports = vi.fn().mockReturnValue(false);
      vi.stubGlobal('CSS', { supports });

      const surface = renderOpenPopover();

      expect(supports).toHaveBeenCalledWith('anchor-name: --a');
      expect(surface).not.toHaveAttribute('popover');
      expect(showPopover).not.toHaveBeenCalled();
      expect(screen.getByText('Content')).toBeInTheDocument();
    });

    it('promotes the surface to the top layer where CSS anchor positioning is supported', () => {
      vi.stubGlobal('CSS', { supports: vi.fn().mockReturnValue(true) });

      const surface = renderOpenPopover();

      expect(surface).toHaveAttribute('popover', 'manual');
      expect(showPopover).toHaveBeenCalledOnce();
    });
  });

  // jsdom has no layout engine, so every element's real rect is all zeros — stubbed here, the way
  // Sidebar.test.tsx stubs its drawer box, keyed on the surface's own class since the anchor
  // wrapper and the trigger it hugs carry none of the classes under test.
  describe('the no-anchor fallback flip (CSS anchor positioning unsupported)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    function stubRects(trigger: DOMRect, surface: DOMRect) {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        return this.classList.contains('popover-surface') ? surface : trigger;
      });
    }

    it('keeps a bottom-start surface at the trigger start edge when it fits the viewport', () => {
      vi.stubGlobal('CSS', { supports: () => false });
      vi.stubGlobal('innerWidth', 1440);
      vi.stubGlobal('innerHeight', 900);
      stubRects(new DOMRect(20, 10, 40, 32), new DOMRect(0, 0, 200, 120));

      const surface = renderOpenPopover();

      expect(surface).toHaveStyle({ left: '20px', top: '42px' });
      expect(surface).toHaveClass('popover-surface--open-down');
    });

    it('flips a bottom-start surface to the trigger end edge when it would overflow the viewport width', () => {
      vi.stubGlobal('CSS', { supports: () => false });
      vi.stubGlobal('innerWidth', 400);
      vi.stubGlobal('innerHeight', 900);
      stubRects(new DOMRect(300, 10, 40, 32), new DOMRect(0, 0, 200, 120));

      const surface = renderOpenPopover();

      // Trigger left (300) + surface width (200) = 500 > innerWidth (400): flips end-aligned,
      // pinned to the trigger's own right edge (300 + 40 − 200 = 140).
      expect(surface).toHaveStyle({ left: '140px' });
    });

    it('opens a surface upward when it would overflow the viewport height', () => {
      vi.stubGlobal('CSS', { supports: () => false });
      vi.stubGlobal('innerWidth', 1440);
      vi.stubGlobal('innerHeight', 400);
      stubRects(new DOMRect(20, 350, 40, 32), new DOMRect(0, 0, 200, 120));

      const surface = renderOpenPopover();

      // Trigger bottom (382) + surface height (120) = 502 > innerHeight (400): opens upward,
      // ending flush with the trigger's own top edge (350 − 120 = 230).
      expect(surface).toHaveStyle({ top: '230px' });
      expect(surface).toHaveClass('popover-surface--open-up');
    });

    it('flips a bottom-end surface to the trigger start edge when it would overflow the viewport width', () => {
      vi.stubGlobal('CSS', { supports: () => false });
      vi.stubGlobal('innerWidth', 1440);
      vi.stubGlobal('innerHeight', 900);
      stubRects(new DOMRect(10, 10, 40, 32), new DOMRect(0, 0, 200, 120));

      const surface = renderOpenPopover('bottom-end');

      // Trigger right (50) − surface width (200) = −150 < 0: flips start-aligned, pinned to the
      // trigger's own left edge (10).
      expect(surface).toHaveStyle({ left: '10px' });
    });

    it('repositions after a scroll event when the trigger has moved', () => {
      vi.stubGlobal('CSS', { supports: () => false });
      vi.stubGlobal('innerWidth', 1440);
      vi.stubGlobal('innerHeight', 900);
      let triggerRect = new DOMRect(20, 10, 40, 32);
      const surfaceRect = new DOMRect(0, 0, 200, 120);
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        return this.classList.contains('popover-surface') ? surfaceRect : triggerRect;
      });

      const surface = renderOpenPopover();
      expect(surface).toHaveStyle({ left: '20px', top: '42px' });

      // The trigger scrolled with its row inside `.container`; nothing but the capture-phase
      // scroll listener tells the fixed box to re-measure against its new position.
      triggerRect = new DOMRect(20, 210, 40, 32);
      fireEvent.scroll(window);

      expect(surface).toHaveStyle({ left: '20px', top: '242px' });
    });

    it('repositions after a resize event when the viewport has narrowed', () => {
      vi.stubGlobal('CSS', { supports: () => false });
      vi.stubGlobal('innerHeight', 900);
      vi.stubGlobal('innerWidth', 1600);
      stubRects(new DOMRect(1300, 10, 80, 32), new DOMRect(0, 0, 200, 120));

      const surface = renderOpenPopover();
      expect(surface).toHaveStyle({ left: '1300px' });

      // The window narrowed without the trigger moving; nothing but the resize listener tells the
      // fixed box to re-measure and flip end-aligned.
      vi.stubGlobal('innerWidth', 1440);
      fireEvent.resize(window);

      // Trigger left (1300) + surface width (200) = 1500 > the narrowed innerWidth (1440): flips
      // end-aligned, pinned to the trigger's own right edge (1300 + 80 − 200 = 1180).
      expect(surface).toHaveStyle({ left: '1180px' });
    });
  });
});
