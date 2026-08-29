import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RunStageStrip from './RunStageStrip';

describe('RunStageStrip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the queued stage pulsing and the later stages outline while queued', () => {
    render(
      <RunStageStrip
        runStatus="queued"
        startedAt={new Date().toISOString()}
        description="Answering…"
      />,
    );

    const list = screen.getByRole('list', { hidden: true });
    const items = list.querySelectorAll('li');
    expect(items[0].className).toContain('run-stage--pulsing');
    expect(items[1].className).toContain('run-stage--outline');
    expect(items[2].className).toContain('run-stage--outline');
  });

  it('shows the answering stage pulsing and the queued stage filled while running', () => {
    render(
      <RunStageStrip
        runStatus="running"
        startedAt={new Date().toISOString()}
        description="Answering…"
      />,
    );

    const items = screen.getByRole('list', { hidden: true }).querySelectorAll('li');
    expect(items[0].className).toContain('run-stage--filled');
    expect(items[1].className).toContain('run-stage--pulsing');
    expect(items[2].className).toContain('run-stage--outline');
  });

  it('carries the given description as sr-only text and no aria-live region', () => {
    const { container } = render(
      <RunStageStrip
        runStatus="running"
        startedAt={new Date().toISOString()}
        description="Still answering — check back once this run completes."
      />,
    );

    expect(
      screen.getByText('Still answering — check back once this run completes.'),
    ).toBeInTheDocument();
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders nothing for a run that is already terminal on mount', () => {
    const { container } = render(
      <RunStageStrip runStatus="completed" startedAt={new Date().toISOString()} description="" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows every stage filled once a run completes, then removes itself once the exit cross-fade ends', async () => {
    const { container, rerender } = render(
      <RunStageStrip runStatus="running" startedAt={new Date().toISOString()} description="" />,
    );

    rerender(
      <RunStageStrip runStatus="completed" startedAt={new Date().toISOString()} description="" />,
    );

    const strip = container.querySelector('.run-stage-strip');
    expect(strip).not.toBeNull();
    expect(strip?.className).toContain('run-stage-strip--exiting');
    const items = strip?.querySelectorAll('li') ?? [];
    expect(items[2].className).toContain('run-stage--filled');

    // No stylesheet is loaded in this test, so `--motion-enter` resolves to nothing and the exit
    // duration reads as 0 — the strip still removes itself asynchronously, on the timer this
    // schedules rather than synchronously on the triggering render.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('measures elapsed time from startedAt rather than from its own mount', () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    render(<RunStageStrip runStatus="running" startedAt={startedAt} description="" />);

    expect(screen.getByText('1:05')).toBeInTheDocument();
  });
});
