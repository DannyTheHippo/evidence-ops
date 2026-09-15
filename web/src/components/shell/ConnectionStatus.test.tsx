import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_LABELS, publishStreamStatus } from '../../lib/use-event-stream';
import type { StreamState } from '../../lib/use-event-stream';
import ConnectionStatus from './ConnectionStatus';

const NON_IDLE_STATES: StreamState[] = ['connecting', 'live', 'stale', 'reconnecting', 'fallback'];

describe('ConnectionStatus', () => {
  afterEach(() => {
    // currentStreamStatus is module-scope in use-event-stream.ts, so it outlives each test.
    act(() => publishStreamStatus('idle'));
  });

  it('renders nothing for idle', () => {
    render(<ConnectionStatus />);

    for (const { label } of Object.values(CONNECTION_LABELS)) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it.each(NON_IDLE_STATES)('shows the %s label and its detail', (state) => {
    render(<ConnectionStatus />);

    act(() => publishStreamStatus(state));

    const { label, detail } = CONNECTION_LABELS[state];
    expect(screen.getByText(label)).toBeInTheDocument();

    const isDetailNode = (_: string, element: Element | null) =>
      element?.classList.contains('sr-only') === true && element.textContent === `. ${detail}`;
    expect(screen.getByText(isDetailNode)).toBeInTheDocument();
  });
});
