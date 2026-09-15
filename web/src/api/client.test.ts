import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  TransportError,
  confirmMeasure,
  fetchDocumentVersionContent,
  getAttestation,
  getDashboardSummary,
  getMe,
  getVerificationById,
  isFieldValidationError,
  listAnswers,
  listApprovals,
  listAuditEvents,
  listConflicts,
  listLedgerCells,
  listLedgerFacts,
  listMeasures,
  listSources,
  listVerifications,
  listWorkflowRuns,
  rejectMeasure,
  updateMeasure,
  updateSource,
  uploadDocument,
} from './client';

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// Mimics `fetch`'s own contract for an aborted request: it never settles on its own, only in
// reaction to the signal the caller passed in — same as the browser rejecting with an AbortError
// once a real network request is cancelled.
function abortableFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
}

const realLocation: Location = window.location;

// jsdom's `location.assign` is a non-configurable property `vi.spyOn` cannot redefine — swapping
// the whole `window.location` for a minimal stub is the only way to observe the call. Carries over
// the real `pathname`/`search` at the moment it is called, so a caller that first navigates via
// `window.history.pushState` still has that path available to `loginHrefFor`.
function stubLocationAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  const { pathname, search } = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, pathname, search },
  });
  return assign;
}

describe('client transport handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('turns a dropped-connection rejection into a typed transport error with one human message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const error = await getMe().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TransportError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('times out a hung request into the same typed transport error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(abortableFetch()));

    const pending = getMe();
    const assertion = expect(pending).rejects.toBeInstanceOf(TransportError);
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
  });

  it('words a timeout differently from a dropped connection', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(abortableFetch()));

    const pending = getMe().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    const timeout = (await pending) as TransportError;

    expect(timeout.reason).toBe('timeout');
    expect(timeout.message).toBe('The server took too long to respond. Try again.');

    vi.useRealTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const network = (await getMe().catch((err: unknown) => err)) as TransportError;

    expect(network.reason).toBe('network');
    expect(network.message).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('propagates a rejection it does not recognize instead of masking it as a transport failure', async () => {
    const bug = new Error('JSON.parse blew up for an unrelated reason');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(bug));

    await expect(getMe()).rejects.toBe(bug);
  });

  it('redirects to /login on a 401 for a non-auth path', async () => {
    const assign = stubLocationAssign();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401)),
    );

    await expect(listSources()).rejects.toMatchObject({ status: 401 });

    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('exempts /auth/* paths from the 401 redirect', async () => {
    const assign = stubLocationAssign();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401)),
    );

    await expect(getMe()).rejects.toMatchObject({ status: 401 });

    expect(assign).not.toHaveBeenCalled();
  });

  it('carries the current path as next on the 401 redirect', async () => {
    window.history.pushState({}, '', '/documents/abc?skip=20');
    const assign = stubLocationAssign();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401)),
    );

    await expect(listSources()).rejects.toMatchObject({ status: 401 });

    expect(assign).toHaveBeenCalledWith('/login?next=%2Fdocuments%2Fabc%3Fskip%3D20');

    window.history.pushState({}, '', '/');
  });

  it('humanises a 429 and keeps retryAfterSeconds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'ignored' }, 429, { 'Retry-After': '42' })),
    );

    const withRetry = (await listSources().catch((err: unknown) => err)) as ApiError;

    expect(withRetry.message).toBe('Too many attempts. Try again in 42 seconds.');
    expect(withRetry.retryAfterSeconds).toBe(42);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'ignored' }, 429)));

    const withoutRetry = (await listSources().catch((err: unknown) => err)) as ApiError;

    expect(withoutRetry.message).toBe('Too many attempts. Try again in a moment.');
    expect(withoutRetry.retryAfterSeconds).toBeUndefined();
  });

  it('singularises a 429 message with one second left', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'ignored' }, 429, { 'Retry-After': '1' })),
    );

    const err = (await listSources().catch((e: unknown) => e)) as ApiError;

    expect(err.message).toBe('Too many attempts. Try again in 1 second.');
  });

  it('raises ApiError for a 2xx body that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>not json</html>', { status: 200 })),
    );

    await expect(listSources()).rejects.toMatchObject({
      message: 'The server sent a response this app could not read.',
    });
  });

  it('reads a blob and gives it the large-body budget', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(abortableFetch()));

    let settled = false;
    const pending = fetchDocumentVersionContent('version-1').catch((err: unknown) => {
      settled = true;
      throw err;
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(TransportError);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    expect(settled).toBe(true);
  });

  it('omits Content-Type on a FormData body, letting the browser set its own multipart boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'doc-1',
        title: 'rent-roll.pdf',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        sourceClass: 'unclassified',
        currentVersion: {
          id: 'v1',
          versionNumber: 1,
          sha256: 'abc',
          sizeBytes: 1,
          ingestionStatus: 'pending',
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await uploadDocument(new File(['a'], 'rent-roll.pdf', { type: 'application/pdf' }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('resolves to undefined on a 204, never attempting to parse an empty body as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(listSources()).resolves.toBeUndefined();
  });

  it('reads retryAfterSeconds from a 429 response’s Retry-After header', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: 'Too many requests' }, 429, { 'Retry-After': '42' }),
        ),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).retryAfterSeconds).toBe(42);
  });

  it('leaves retryAfterSeconds undefined when the response carries no Retry-After header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Server error' }, 500)),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).retryAfterSeconds).toBeUndefined();
  });

  it('leaves retryAfterSeconds undefined for a non-numeric Retry-After header', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: 'Too many requests' }, 429, { 'Retry-After': 'not-a-number' }),
        ),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).retryAfterSeconds).toBeUndefined();
  });
});

describe('client error body parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses a string message as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ statusCode: 400, message: 'Bad request' }, 400)),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).message).toBe('Bad request');
  });

  it('joins a string[] message with "; "', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { statusCode: 400, message: ['ownerEmail must be an email', 'unit is required'] },
            400,
          ),
        ),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).message).toBe('ownerEmail must be an email; unit is required');
  });

  it('carries a well-formed errors array through to ApiError.fields', async () => {
    const errors = [
      { field: 'ownerEmail', message: 'ownerEmail must be an email' },
      { field: 'values.0.unit', message: 'unit should not be empty' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            statusCode: 400,
            error: 'Bad Request',
            message: 'ownerEmail must be an email; values.0.unit should not be empty',
            errors,
          },
          400,
        ),
      ),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).fields).toEqual(errors);
  });

  it('leaves fields undefined for a domain 400 that carries no errors key', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ status: 400, message: 'Source already exists' }, 400)),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).fields).toBeUndefined();
  });

  it('drops a malformed errors payload that is not an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ statusCode: 400, message: 'Bad request', errors: 'not-an-array' }, 400),
        ),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).fields).toBeUndefined();
  });

  it('drops an errors array of bare strings', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { statusCode: 400, message: 'Bad request', errors: ['ownerEmail must be an email'] },
            400,
          ),
        ),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).fields).toBeUndefined();
  });

  it('keeps only the well-formed entries of a partially malformed errors array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            statusCode: 400,
            message: 'Bad request',
            errors: [
              { field: 'ownerEmail', message: 'ownerEmail must be an email' },
              { message: 'missing its field' },
            ],
          },
          400,
        ),
      ),
    );

    const error = await listSources().catch((err: unknown) => err);

    expect((error as ApiError).fields).toEqual([
      { field: 'ownerEmail', message: 'ownerEmail must be an email' },
    ]);
  });
});

describe('isFieldValidationError', () => {
  it('returns false for a plain Error', () => {
    expect(isFieldValidationError(new Error('boom'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isFieldValidationError(null)).toBe(false);
  });

  it('returns false for an ApiError with no fields', () => {
    expect(isFieldValidationError(new ApiError(400, 'Bad request'))).toBe(false);
  });

  it('returns true for an ApiError carrying a non-empty fields array', () => {
    const error = new ApiError(400, 'Bad request', [
      { field: 'ownerEmail', message: 'ownerEmail must be an email' },
    ]);

    expect(isFieldValidationError(error)).toBe(true);
  });
});

describe('getDashboardSummary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches the summary counts from /dashboard/summary', async () => {
    const summary = {
      pendingApprovalCount: 2,
      openConflictCount: 1,
      documentCount: 128,
      sourceCount: 4,
      ingestionFailedCount: 2,
      syncFailedCount: 1,
      needsOcrCount: 3,
      factsFailedCount: 1,
      answerCount: 12,
      hasIngestedDocument: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(summary));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDashboardSummary()).resolves.toEqual(summary);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/dashboard/summary');
  });
});

describe('listConflicts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('comma-joins ids into a single query parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listConflicts({ ids: ['a', 'b'] });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/conflicts?ids=a%2Cb');
  });
});

describe('updateSource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends an explicit null owner in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'source-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await updateSource('source-1', { owner: null });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ owner: null });
  });

  it('omits owner from the request body when it is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'source-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await updateSource('source-1', { enabled: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
  });
});

describe('listAnswers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serialises from and to when given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listAnswers({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/api/v1/answers?from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-08T00%3A00%3A00.000Z',
    );
  });

  it('omits from and to when absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listAnswers();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/answers');
  });
});

describe('listWorkflowRuns', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serialises from and to when given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listWorkflowRuns({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/api/v1/workflow-runs?from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-08T00%3A00%3A00.000Z',
    );
  });

  it('omits from and to when absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listWorkflowRuns();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/workflow-runs');
  });
});

describe('listAuditEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serialises from and to when given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listAuditEvents({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/api/v1/audit-events?from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-08T00%3A00%3A00.000Z',
    );
  });

  it('omits from and to when absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listAuditEvents();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/audit-events');
  });
});

describe('listApprovals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serialises workflowId when given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listApprovals({ workflowId: 'workflow-1' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/approvals?workflowId=workflow-1');
  });

  it('omits workflowId when absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listApprovals();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/approvals');
  });
});

describe('listLedgerCells', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serialises only the filters it was given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listLedgerCells({ entity: 'Northgate Business Park', state: 'conflicted' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/ledger?entity=Northgate+Business+Park&state=conflicted');
  });
});

describe('listLedgerFacts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('omits period from the query when it is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listLedgerFacts({ entity: 'Northgate Business Park', measure: 'cap_rate' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/ledger/facts?entity=Northgate+Business+Park&measure=cap_rate');
  });
});

describe('listMeasures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serialises status and limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listMeasures({ status: 'proposed', limit: 20 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/measures?status=proposed&limit=20');
  });
});

describe('confirmMeasure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends the edits as the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'measure-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await confirmMeasure('measure-1', { label: 'Cap Rate', tolerance: 0.0025 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/measures/measure-1/confirm');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ label: 'Cap Rate', tolerance: 0.0025 });
  });
});

describe('rejectMeasure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends an empty body when no reason is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'measure-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await rejectMeasure('measure-1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('sends the reason when one is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'measure-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await rejectMeasure('measure-1', 'duplicate');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'duplicate' });
  });
});

describe('updateMeasure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('issues a PATCH carrying the edits', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'measure-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await updateMeasure('measure-1', { tolerance: 0.005 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/measures/measure-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ tolerance: 0.005 });
  });
});

describe('listVerifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serialises sort, sortDir, skip and limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await listVerifications({ sort: 'createdAt', sortDir: 'desc', skip: 20, limit: 10 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/verifications?skip=20&limit=10&sort=createdAt&sortDir=desc');
  });
});

describe('getVerificationById', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('builds the by-id path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'verification-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await getVerificationById('verification-1');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/verifications/verification-1');
  });
});

describe('getAttestation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('builds the answers attestation path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await getAttestation('answers', 'answer-1');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/answers/answer-1/attestation');
  });

  it('builds the verifications attestation path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await getAttestation('verifications', 'verification-1');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/verifications/verification-1/attestation');
  });
});
