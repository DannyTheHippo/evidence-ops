import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { publishStreamStatus } from '../../lib/use-event-stream';
import ConnectionStatus from './ConnectionStatus';

describe('ConnectionStatus', () => {
  afterEach(() => {
    // currentStreamStatus is module-scope in use-event-stream.ts, so it outlives each test.
    act(() => publishStreamStatus('idle'));
  });

  it('renders no label while idle', () => {
    render(<ConnectionStatus />);

    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    expect(screen.queryByText('Connecting')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(screen.queryByText('Polling')).not.toBeInTheDocument();
  });

  it('renders a Live label once the stream publishes live', () => {
    render(<ConnectionStatus />);

    act(() => publishStreamStatus('live'));

    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('renders a label for each non-idle stream state', () => {
    render(<ConnectionStatus />);

    act(() => publishStreamStatus('connecting'));
    expect(screen.getByText('Connecting')).toBeInTheDocument();

    act(() => publishStreamStatus('stale'));
    expect(screen.getByText('Stale')).toBeInTheDocument();

    act(() => publishStreamStatus('fallback'));
    expect(screen.getByText('Polling')).toBeInTheDocument();
  });
});
