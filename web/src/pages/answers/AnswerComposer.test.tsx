import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, getToasts } from '../../components/ui/toast';
import { clearAnnouncements, subscribeAnnouncements } from '../../lib/announce';
import { clearSession } from '../../lib/auth';
import AnswerComposer from './AnswerComposer';

const EXAMPLE_QUESTION = 'What is the current occupancy rate across the portfolio?';
const ENTITY_NAME = 'Northgate Business Park';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function entityListResponse(): Response {
  return jsonResponse({
    docs: [
      {
        id: 'entity-1',
        canonicalName: ENTITY_NAME,
        aliases: [],
        harvestedAliases: [],
        createdAt: new Date().toISOString(),
      },
    ],
    count: 1,
  });
}

// The composer also fetches the entity list on mount, so "issued no request" assertions count the
// question requests specifically rather than every call on the mock.
function questionRequests(fetchMock: {
  mock: { calls: readonly unknown[][] };
}): readonly unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/v1/questions');
}

// jsdom's native `.focus()` moves `document.activeElement` but does not dispatch the bubbling
// `focusin` React 19 listens for, so both calls are needed to move real focus and to open the
// combobox's own listbox.
function focusInput(input: HTMLElement) {
  input.focus();
  fireEvent.focus(input);
}

function ask(question: string) {
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('AnswerComposer', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
    clearToasts();
    clearAnnouncements();
  });

  it('guards against a double submit while the button stays enabled and busy', async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(jsonResponse({ id: 'answer-1', runStatus: 'queued' }, 201)),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Q' } });
    const button = screen.getByRole('button', { name: 'Ask' });
    fireEvent.click(button);
    // The guard now lives in useFormSubmit's inFlightRef, not the `disabled` attribute — a busy
    // button stays enabled so it never drops focus, but a second click still issues no request.
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await screen.findByText('queued');

    expect(questionRequests(fetchMock)).toHaveLength(1);
  });

  it('keeps focus on the question field while the ask is in flight', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    const input = screen.getByLabelText('Question');
    ask('Q');

    await waitFor(() => expect(input).toHaveAttribute('aria-busy', 'true'));
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('readonly');

    resolveFetch(jsonResponse({ id: 'answer-4', runStatus: 'queued' }, 201));
    await screen.findByText('queued');
  });

  it('pressing Enter while the ask is in flight issues no second request', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(
      (_url: string) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    ask('Q');
    // Enter in a single-line input submits the form natively in a browser; jsdom does not
    // replicate that, so a direct submit event stands in for the keystroke — the assertion that
    // matters is that the in-flight guard closes this path too, not just a second button click.
    const form = screen.getByRole('button', { name: 'Asking…' }).closest('form');
    fireEvent.submit(form!);

    resolveFetch(jsonResponse({ id: 'answer-5', runStatus: 'queued' }, 201));
    await screen.findByText('queued');

    expect(questionRequests(fetchMock)).toHaveLength(1);
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

  it('leaves focus where the operator moved it while a 429 cooldown ticks', async () => {
    // Only the interval clock is faked: the cooldown ticks on setInterval, while fetch, the
    // response body and findBy* keep running on the real event loop.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fetchMock = vi.fn((url: string) =>
      url === '/api/v1/questions'
        ? Promise.resolve(
            new Response(JSON.stringify({ message: 'Too many attempts.' }), {
              status: 429,
              headers: { 'Content-Type': 'application/json', 'Retry-After': '3' },
            }),
          )
        : Promise.resolve(entityListResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    ask('Q');
    expect(
      await screen.findByText('Too many attempts. Try again in 3 seconds.'),
    ).toBeInTheDocument();

    const askButton = screen.getByRole('button', { name: 'Ask' });
    askButton.focus();
    expect(askButton).toHaveFocus();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByText('Too many attempts. Try again in 1 second.')).toBeInTheDocument();
    expect(screen.getByLabelText('Question')).not.toHaveFocus();
    expect(askButton).toHaveFocus();
  });

  it('rejects a trimmed-empty question, refocusing the input and issuing no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    fireEvent.change(screen.getByLabelText('Question'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(await screen.findByText('Enter a question')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Question')).toHaveFocus());
    expect(questionRequests(fetchMock)).toHaveLength(0);
  });

  it('fills the input and focuses it from an example chip, never submitting', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    fireEvent.click(screen.getByRole('button', { name: EXAMPLE_QUESTION }));

    const input = screen.getByLabelText('Question');
    expect(input).toHaveValue(EXAMPLE_QUESTION);
    expect(input).toHaveFocus();
    expect(questionRequests(fetchMock)).toHaveLength(0);
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

  it('announces the outcome once when the run reaches a terminal state', async () => {
    const completed = {
      id: 'answer-6',
      questionText: 'Q',
      runStatus: 'completed',
      outcome: { kind: 'insufficient_evidence', reason: 'No document mentions it.' },
      citations: [],
      atoms: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
      withdrawnCitedDocVersionIds: [],
    };
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse({ id: 'answer-6', runStatus: 'queued' }, 201)
          : jsonResponse(completed),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const messages: string[] = [];
    subscribeAnnouncements((message) => messages.push(message));

    render(<AnswerComposer pollIntervalMs={5} />);
    ask('Q');

    await waitFor(() => expect(messages).toContain('Answer ready: insufficient evidence.'));
    expect(messages).toHaveLength(1);
  });

  it('announces a terminal outcome only once across re-renders', async () => {
    const completed = {
      id: 'answer-7',
      questionText: 'Q',
      runStatus: 'completed',
      outcome: { kind: 'insufficient_evidence', reason: 'No document mentions it.' },
      citations: [],
      atoms: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
      withdrawnCitedDocVersionIds: [],
    };
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse({ id: 'answer-7', runStatus: 'queued' }, 201)
          : jsonResponse(completed),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const messages: string[] = [];
    subscribeAnnouncements((message) => messages.push(message));

    // A fresh `onRunSettled` closure on every render, matching a real page that inlines it — an
    // unstable prop reference must not defeat the once-per-run guard on its own re-render.
    const { rerender } = render(<AnswerComposer pollIntervalMs={5} onRunSettled={() => {}} />);
    ask('Q');

    await waitFor(() => expect(messages).toHaveLength(1));

    rerender(<AnswerComposer pollIntervalMs={5} onRunSettled={() => {}} />);
    rerender(<AnswerComposer pollIntervalMs={5} onRunSettled={() => {}} />);

    expect(messages).toHaveLength(1);
  });

  it('calls onRunSettled once the run reaches a terminal state', async () => {
    const completed = {
      id: 'answer-8',
      questionText: 'Q',
      runStatus: 'failed',
      citations: [],
      atoms: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
      withdrawnCitedDocVersionIds: [],
    };
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse({ id: 'answer-8', runStatus: 'queued' }, 201)
          : jsonResponse(completed),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onRunSettled = vi.fn();

    render(<AnswerComposer pollIntervalMs={5} onRunSettled={onRunSettled} />);
    ask('Q');

    await waitFor(() => expect(onRunSettled).toHaveBeenCalledTimes(1));
    expect(onRunSettled).toHaveBeenCalledTimes(1);
  });

  it('offers the tenant own entities and inserts the chosen name into the draft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.startsWith('/api/v1/canonical-entities')
          ? Promise.resolve(entityListResponse())
          : Promise.reject(new Error('no request expected')),
      ),
    );

    render(<AnswerComposer pollIntervalMs={5} />);

    const question = screen.getByLabelText('Question');
    fireEvent.change(question, { target: { value: 'What is the cap rate for' } });

    const combobox = screen.getByRole('combobox', { name: /^Entity/ });
    focusInput(combobox);
    expect(await screen.findByRole('option', { name: ENTITY_NAME })).toBeInTheDocument();
    fireEvent.keyDown(combobox, { key: 'Enter' });

    expect(question).toHaveValue(`What is the cap rate for ${ENTITY_NAME}`);
    expect(question).toHaveFocus();
  });

  it('still allows asking when the entity list fails to load', async () => {
    const fetchMock = vi.fn((url: string) =>
      url.startsWith('/api/v1/canonical-entities')
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(jsonResponse({ id: 'answer-9', runStatus: 'queued' }, 201)),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerComposer pollIntervalMs={5} />);

    const combobox = screen.getByRole('combobox', { name: /^Entity/ });
    focusInput(combobox);
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    ask('Q');
    await screen.findByText('queued');

    expect(questionRequests(fetchMock)).toHaveLength(1);
  });

  it('no longer repeats the placeholder as an example chip', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no request expected'))),
    );

    render(<AnswerComposer pollIntervalMs={5} />);

    const placeholder = screen.getByLabelText('Question').getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
    expect(screen.queryByRole('button', { name: placeholder! })).not.toBeInTheDocument();
    // The chips name no entity either: an entity name comes from the tenant's own list, not from
    // a suggestion baked into the build.
    expect(screen.getByRole('button', { name: EXAMPLE_QUESTION })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(ENTITY_NAME) })).not.toBeInTheDocument();
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
