import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, getToasts } from '../../components/ui/toast';
import { clearSession } from '../../lib/auth';
import AnswerComposer from './AnswerComposer';

const EXAMPLE_QUESTION = 'What is the cap rate for Northgate Business Park in Q1 2025?';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ask(question: string) {
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('AnswerComposer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
    clearToasts();
  });

  it('guards against a double submit between the click and the button becoming disabled', async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(jsonResponse({ id: 'answer-1', runStatus: 'queued' }, 201)),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Q' } });
    const button = screen.getByRole('button', { name: 'Ask' });
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByText('queued');

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/v1/questions')).toHaveLength(1);
  });

  it('deletes the error toast for a failed submit — the page alert is the only report', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: 'Question limit exceeded' }, 500)),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    ask('Q');

    expect(await screen.findByText('Question limit exceeded')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Question')).toHaveFocus());
    // Proves the toast deletion, rather than merely asserting the alert renders: the module-scope
    // toast store stays empty, so nothing was ever reported through `notify()` for this failure.
    expect(getToasts()).toHaveLength(0);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('rejects a trimmed-empty question, refocusing the input and issuing no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    fireEvent.change(screen.getByLabelText('Question'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(await screen.findByText('Enter a question')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Question')).toHaveFocus());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fills the input and focuses it from an example chip, never submitting', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    fireEvent.click(screen.getByRole('button', { name: EXAMPLE_QUESTION }));

    const input = screen.getByLabelText('Question');
    expect(input).toHaveValue(EXAMPLE_QUESTION);
    expect(input).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hides the example chips once a run exists', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ id: 'answer-2', runStatus: 'queued' }, 201)),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    expect(screen.getByRole('button', { name: EXAMPLE_QUESTION })).toBeInTheDocument();

    ask('Q');
    await screen.findByText('queued');

    expect(screen.queryByRole('button', { name: EXAMPLE_QUESTION })).not.toBeInTheDocument();
  });

  it('calls onRunStarted once startQuestion resolves, so the page can refresh its history', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ id: 'answer-3', runStatus: 'queued' }, 201)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onRunStarted = vi.fn();

    render(<AnswerComposer pollIntervalMs={5} onRunStarted={onRunStarted} />);

    ask('Q');

    await waitFor(() => expect(onRunStarted).toHaveBeenCalledTimes(1));
  });

  it('adopts a non-empty initialQuestion arriving after mount, without a later empty one clearing it', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no request expected'))),
    );

    const { rerender } = render(<AnswerComposer pollIntervalMs={5} />);

    expect(screen.getByLabelText('Question')).toHaveValue('');

    rerender(<AnswerComposer pollIntervalMs={5} initialQuestion="What is the vacancy rate?" />);

    expect(screen.getByLabelText('Question')).toHaveValue('What is the vacancy rate?');

    // The page strips `?q=` right after adoption, which passes `initialQuestion: ''` back down —
    // this must not clear what has just been adopted.
    rerender(<AnswerComposer pollIntervalMs={5} initialQuestion="" />);

    expect(screen.getByLabelText('Question')).toHaveValue('What is the vacancy rate?');
  });
});
