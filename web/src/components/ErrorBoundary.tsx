import type { ReactNode } from 'react';
import { Component } from 'react';
import { IconXOctagon } from './icons';
import EmptyState from './ui/EmptyState';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Identifies the subtree currently mounted beneath the boundary — pass the route pathname so
   * a crash on one page does not survive navigating to a different one. Changing this value while
   * the boundary is showing its fallback clears the caught error and remounts `children`. */
  resetKey: unknown;
}

interface ErrorBoundaryState {
  hasError: boolean;
  resetKey: unknown;
}

/**
 * Catches a render-time throw from anything beneath it — including a rejected dynamic `import()`
 * propagating out of a lazy component — and shows a recovery view instead of losing the tree past
 * the nearest ancestor. This is the one class component in the SPA: React exposes error
 * interception only through `getDerivedStateFromError`/`componentDidCatch`, neither of which has a
 * hook equivalent, so a boundary is either a class or a fourth runtime dependency.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return { hasError: false, resetKey: props.resetKey };
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        // `EmptyState` carries no role of its own — an empty list is not an event worth
        // interrupting for. A crash is: this replaces whatever the reader was on, with no other
        // signal that it happened, so the wrapper supplies the live region the fallback needs.
        <div role="alert">
          <EmptyState
            icon={<IconXOctagon size={24} />}
            title="This page couldn't load"
            description="Something broke while rendering it. Reload to try again."
            action={
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
            }
          />
        </div>
      );
    }
    return this.props.children;
  }
}
