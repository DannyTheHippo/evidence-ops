import { fireEvent, render, screen } from '@testing-library/react';
import { Suspense, lazy } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary';

function Thrower(): never {
  throw new Error('render boom');
}

describe('ErrorBoundary', () => {
  // React logs every error a boundary catches to console.error on its own — expected here, not a
  // signal of an unhandled failure, so it is silenced to keep the test output readable.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary resetKey="/a">
        <p>page content</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('page content')).toBeInTheDocument();
  });

  it('renders the fallback in place of a child that throws during render, leaving surrounding chrome intact', () => {
    render(
      <div>
        <nav aria-label="Primary">shell nav</nav>
        <ErrorBoundary resetKey="/a">
          <Thrower />
        </ErrorBoundary>
      </div>,
    );

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByText("This page couldn't load")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('renders the fallback when a lazy chunk fails to load', async () => {
    const BrokenChunk = lazy(() =>
      Promise.reject(new Error('Failed to fetch dynamically imported module')),
    );

    render(
      <ErrorBoundary resetKey="/a">
        <Suspense fallback={<p>loading…</p>}>
          <BrokenChunk />
        </Suspense>
      </ErrorBoundary>,
    );

    expect(await screen.findByText("This page couldn't load")).toBeInTheDocument();
  });

  it('reloads the page when the fallback action is clicked', () => {
    const reload = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, reload },
    });

    render(
      <ErrorBoundary resetKey="/a">
        <Thrower />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(reload).toHaveBeenCalled();

    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('clears a caught error and shows the new children once resetKey changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Thrower />
      </ErrorBoundary>,
    );
    expect(screen.getByText("This page couldn't load")).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="/b">
        <p>fresh page</p>
      </ErrorBoundary>,
    );

    expect(screen.queryByText("This page couldn't load")).not.toBeInTheDocument();
    expect(screen.getByText('fresh page')).toBeInTheDocument();
  });
});
