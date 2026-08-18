import { clearSession, setSession } from '../lib/auth';

const API = '/api/v1';

export type UserRole = 'admin' | 'member';

export interface Me {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthToken {
  accessToken: string;
  user: Me;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return res.statusText || `HTTP ${res.status}`;
    const body = JSON.parse(text) as unknown;
    if (
      body !== null &&
      typeof body === 'object' &&
      'message' in body &&
      typeof (body as Record<string, unknown>).message === 'string'
    ) {
      return (body as Record<string, unknown>).message as string;
    }
  } catch {}
  return res.statusText || `HTTP ${res.status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const headers: Record<string, string> = {
    // A FormData body needs the browser to set its own multipart boundary; a fixed
    // 'application/json' header here would make the server unable to parse the upload.
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(init?.headers as Record<string, string> | undefined),
  };

  // The credential is now an HttpOnly cookie, not a header the SPA attaches itself —
  // 'same-origin' is what makes the browser actually send it.
  const res = await fetch(`${API}${path}`, { ...init, headers, credentials: 'same-origin' });

  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.assign('/login');
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    throw new ApiError(res.status, await readErrorMessage(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : undefined) as T;
}

function jsonBody(data: unknown): RequestInit {
  return { body: JSON.stringify(data) };
}

export function register(email: string, password: string): Promise<Me> {
  return request<Me>('/auth/register', { method: 'POST', ...jsonBody({ email, password }) });
}

export async function login(email: string, password: string): Promise<AuthToken> {
  const result = await request<AuthToken>('/auth/login', {
    method: 'POST',
    ...jsonBody({ email, password }),
  });
  setSession(result.user);
  return result;
}

export async function logout(): Promise<void> {
  // Client-side logout must not depend on the server's answer: a CSRF rejection, a 500, or a
  // dropped connection must not leave the local session cache believing the user is still
  // authenticated just because the request that says otherwise never arrived.
  try {
    await request<void>('/auth/logout', { method: 'POST' });
  } finally {
    clearSession();
  }
}

export function getMe(): Promise<Me> {
  return request<Me>('/auth/me');
}

// ── Documents ────────────────────────────────────────────────────────────

export type DocumentSourceKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'tsv' | 'txt' | 'md';
export type DocumentVersionIngestionStatus = 'pending' | 'completed' | 'failed';

export interface DocumentVersion {
  id: string;
  versionNumber: number;
  sha256: string;
  sizeBytes: number;
  ingestionStatus: DocumentVersionIngestionStatus;
  /** Present only when ingestionStatus is 'failed' — the parser exception message from the
   * attempt that set that status. */
  ingestionFailureReason?: string;
  createdAt: string;
}

// Named `EvidenceDocument`, not `Document` — the latter shadows the DOM global that the rest
// of the SPA (and jsdom in tests) relies on.
export interface EvidenceDocument {
  id: string;
  title: string;
  sourceKind: DocumentSourceKind;
  mimeType: string;
  currentVersion: DocumentVersion;
  createdAt: string;
}

export interface DocumentWithVersions extends EvidenceDocument {
  versions: DocumentVersion[];
}

export interface WithCount<T> {
  docs: T[];
  count: number;
}

export function uploadDocument(
  file: File,
  options?: { documentId?: string; title?: string },
): Promise<EvidenceDocument> {
  const formData = new FormData();
  formData.append('file', file);
  if (options?.documentId) formData.append('documentId', options.documentId);
  else formData.append('title', options?.title?.trim() || file.name);
  return request<EvidenceDocument>('/documents', { method: 'POST', body: formData });
}

export function listDocuments(params?: {
  skip?: number;
  limit?: number;
}): Promise<WithCount<EvidenceDocument>> {
  const query = new URLSearchParams();
  if (params?.skip !== undefined) query.set('skip', String(params.skip));
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  return request<WithCount<EvidenceDocument>>(`/documents${qs ? `?${qs}` : ''}`);
}

export function getDocumentById(id: string): Promise<DocumentWithVersions> {
  return request<DocumentWithVersions>(`/documents/${id}`);
}

// Admin-only, and irreversible: the server cascades to versions, chunks, facts and stored bytes.
// Answers that already cited this document keep their citations — see documents.service.ts.
export async function deleteDocument(id: string): Promise<void> {
  await request<void>(`/documents/${id}`, { method: 'DELETE' });
}

// A plain URL builder, not a `request<T>()` call: the browser fetches this href directly to
// drive a file download, so there is no JSON body for `request<T>()` to parse.
export function documentVersionContentUrl(versionId: string): string {
  return `${API}/documents/versions/${versionId}/content`;
}

// A plain URL builder, not a `request<T>()` call — a browser-native EventSource consumes this
// href directly, so there is no JSON body for `request<T>()` to parse.
export function documentEventsUrl(): string {
  return `${API}/documents/events`;
}

// What a citation actually points at — the stored evidence_chunks, not a re-parse of the source
// document. Chunk granularity may span pages, ~12% overlap means adjacent chunks repeat some
// text, and elements quarantined at ingestion are absent entirely: not a faithful page render.
export interface EvidenceChunkView {
  id: string;
  text: string;
  tokenCount: number;
  locator: Locator;
}

export function listVersionChunks(versionId: string): Promise<WithCount<EvidenceChunkView>> {
  return request<WithCount<EvidenceChunkView>>(`/documents/versions/${versionId}/chunks`);
}

// ── Questions & answers ─────────────────────────────────────────────────

export type AnswerRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export type Locator =
  | {
      kind: 'pdf-page';
      extractorVersion: string;
      page: number;
      boundingBox?: { x: number; y: number; width: number; height: number };
    }
  | {
      kind: 'docx-paragraph';
      extractorVersion: string;
      paragraphIndex: number;
      headingPath: string[];
    }
  | { kind: 'xlsx-region'; extractorVersion: string; sheetName: string; range: string }
  | { kind: 'xlsx-cell'; extractorVersion: string; sheetName: string; cell: string }
  | { kind: 'text-block'; extractorVersion: string; blockIndex: number; headingPath: string[] }
  | { kind: 'pptx-slide'; extractorVersion: string; slide: number };

export interface Citation {
  docVersionId: string;
  sha256: string;
  chunkId: string;
  locator: Locator;
  quote: string;
}

export interface Claim {
  statement: string;
  citations: Citation[];
}

export interface ConflictingValue {
  value: number;
  unit: string;
  sourceChunkId: string;
}

export interface ConflictingFactKey {
  entity: string;
  metric: string;
  period: string;
}

export type InsufficientEvidenceReasonCode =
  | 'no_relevant_evidence'
  | 'evidence_does_not_address_question'
  | 'retrieved_evidence_contradicts_itself';

export type AnswerOutcome =
  | { kind: 'answered'; claims: Claim[] }
  // `reasonCode` is present only for a model-authored abstention (absent on legacy answers and on
  // the grounding gate's own degraded insufficient_evidence — see `answer.contract.ts`'s doc
  // comment on the API side). It never changes what is rendered here on its own: the API only ever
  // returns `kind: 'conflicting_evidence'` once it has independently verified the hint.
  | { kind: 'insufficient_evidence'; reason: string; reasonCode?: InsufficientEvidenceReasonCode }
  | { kind: 'conflicting_evidence'; factKey: ConflictingFactKey; values: ConflictingValue[] };

export interface DroppedClaim {
  statement: string;
  reason: string;
}

export interface VerificationReport {
  verifiedClaimCount: number;
  totalClaimCount: number;
  droppedClaims: DroppedClaim[];
}

export interface Answer {
  id: string;
  questionText: string;
  runStatus: AnswerRunStatus;
  // Present only once runStatus is 'completed' — never render this as a final outcome before
  // then (see qa.controller.ts / answer.response.dto.ts).
  outcome?: AnswerOutcome;
  claimCoverage?: number;
  // Number of evidence chunks retrieved for this run. Present only once runStatus is
  // 'completed', same gate as outcome above.
  retrievedChunkCount?: number;
  citations: Citation[];
  conflictIds: string[];
  createdAt: string;
  // QA synthesis spend only — not embedding or extraction spend. Present only once runStatus is
  // 'completed', same gate as outcome above.
  usage?: { promptTokens: number; completionTokens: number; costUsd: number };
  // The grounding check's claim-verification outcome. Present only once runStatus is 'completed',
  // same gate as outcome above.
  verificationReport?: VerificationReport;
}

export interface StartQuestionResult {
  id: string;
  runStatus: AnswerRunStatus;
}

export function startQuestion(questionText: string): Promise<StartQuestionResult> {
  return request<StartQuestionResult>('/questions', {
    method: 'POST',
    ...jsonBody({ questionText }),
  });
}

export function getAnswerById(id: string): Promise<Answer> {
  return request<Answer>(`/answers/${id}`);
}

// Three independent optional filters, so this one builds its query with
// URLSearchParams rather than the ad-hoc template literals above.
export function listAnswers(params?: {
  skip?: number;
  limit?: number;
  runStatus?: AnswerRunStatus;
}): Promise<WithCount<Answer>> {
  const query = new URLSearchParams();
  if (params?.skip !== undefined) query.set('skip', String(params.skip));
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  if (params?.runStatus) query.set('runStatus', params.runStatus);
  const qs = query.toString();
  return request<WithCount<Answer>>(`/answers${qs ? `?${qs}` : ''}`);
}

// A plain URL builder, not a `request<T>()` call — a browser-native EventSource consumes this
// href directly, so there is no JSON body for `request<T>()` to parse.
export function answerEventsUrl(id: string): string {
  return `${API}/answers/${id}/events`;
}

// ── Retrieval ────────────────────────────────────────────────────────────

// What `search_evidence` returns — the retrieved chunk itself, not a relevance score, because
// the API does not return one.
export interface RetrievedChunkView {
  chunkId: string;
  docVersionId: string;
  sha256: string;
  text: string;
  locator: Locator;
}

export function searchEvidence(query: string): Promise<WithCount<RetrievedChunkView>> {
  return request<WithCount<RetrievedChunkView>>(
    `/retrieval/search?query=${encodeURIComponent(query)}`,
  );
}

// ── Conflicts ────────────────────────────────────────────────────────────

export type ConflictStatus = 'open' | 'resolved' | 'dismissed';

export interface ConflictValue {
  factId: string;
  value: number;
  unit: string;
  sourceChunkId: string;
  documentVersionId: string;
  locator: Locator;
}

export type ConflictRuleFired = 'authority' | 'recency' | 'none';

export interface Conflict {
  id: string;
  factKey: ConflictingFactKey;
  factIds: string[];
  values: ConflictValue[];
  magnitude: number;
  status: ConflictStatus;
  createdAt: string;
  proposedWinnerFactId?: string;
  ruleFired: ConflictRuleFired;
  explanation: string;
}

export function listConflicts(params?: {
  skip?: number;
  limit?: number;
  status?: ConflictStatus;
}): Promise<WithCount<Conflict>> {
  const query = new URLSearchParams();
  if (params?.skip !== undefined) query.set('skip', String(params.skip));
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  if (params?.status) query.set('status', params.status);
  const qs = query.toString();
  return request<WithCount<Conflict>>(`/conflicts${qs ? `?${qs}` : ''}`);
}

export function requestConflictResolution(
  conflictId: string,
  winningFactId: string,
): Promise<WorkflowRun> {
  return request<WorkflowRun>(`/conflicts/${conflictId}/resolution-requests`, {
    method: 'POST',
    ...jsonBody({ winningFactId }),
  });
}

// ── Approvals ────────────────────────────────────────────────────────────

export type ApprovalState = 'pending' | 'approved' | 'rejected';
export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalSubject {
  entityType: string;
  entityId: string;
}

export interface Approval {
  id: string;
  subject: ApprovalSubject;
  action: string;
  summary: string;
  requestedBy?: string;
  // Underlying Temporal workflow id, present when this approval gates a workflow (matches
  // WorkflowRun.workflowId) — absent for an approval created outside one.
  workflowId?: string;
  state: ApprovalState;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
  createdAt: string;
}

export function listApprovals(params?: {
  skip?: number;
  limit?: number;
  state?: ApprovalState;
}): Promise<WithCount<Approval>> {
  const query = new URLSearchParams();
  if (params?.skip !== undefined) query.set('skip', String(params.skip));
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  if (params?.state) query.set('state', params.state);
  const qs = query.toString();
  return request<WithCount<Approval>>(`/approvals${qs ? `?${qs}` : ''}`);
}

export function decideApproval(
  id: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<Approval> {
  return request<Approval>(`/approvals/${id}/decision`, {
    method: 'POST',
    ...jsonBody(reason ? { decision, reason } : { decision }),
  });
}

// ── Workflow runs ────────────────────────────────────────────────────────

export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed';

// Only the workflows that record a run row. `answer-question` and `ingest-document-version` run
// without one, so they never appear here. Absent on rows written before the field existed.
export type WorkflowRunType = 'resolve-conflict' | 'sync-source';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowType?: WorkflowRunType;
  status: WorkflowRunStatus;
  currentStep?: string;
  errorMessage?: string;
  createdAt: string;
}

export function getWorkflowRunById(id: string): Promise<WorkflowRun> {
  return request<WorkflowRun>(`/workflow-runs/${id}`);
}

export function listWorkflowRuns(params?: {
  workflowId?: string;
  skip?: number;
  limit?: number;
}): Promise<WithCount<WorkflowRun>> {
  const query = new URLSearchParams();
  if (params?.workflowId) query.set('workflowId', params.workflowId);
  if (params?.skip !== undefined) query.set('skip', String(params.skip));
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  return request<WithCount<WorkflowRun>>(`/workflow-runs${qs ? `?${qs}` : ''}`);
}

// A plain URL builder, not a `request<T>()` call — a browser-native EventSource consumes this
// href directly, so there is no JSON body for `request<T>()` to parse.
export function workflowRunEventsUrl(id: string): string {
  return `${API}/workflow-runs/${id}/events`;
}

// ── Audit events ─────────────────────────────────────────────────────────

export interface AuditEventSubject {
  entityType: string;
  entityId: string;
}

export interface AuditEventView {
  id: string;
  actor: string;
  action: string;
  subject: AuditEventSubject;
  timestamp: string;
  correlationId: string;
  createdAt: string;
}

// Four independent optional filters, so this one builds its query with
// URLSearchParams rather than the ad-hoc template literals above.
export function listAuditEvents(params?: {
  skip?: number;
  limit?: number;
  action?: string;
  entityType?: string;
  entityId?: string;
}): Promise<WithCount<AuditEventView>> {
  const query = new URLSearchParams();
  if (params?.skip !== undefined) query.set('skip', String(params.skip));
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  if (params?.action) query.set('action', params.action);
  if (params?.entityType) query.set('entityType', params.entityType);
  if (params?.entityId) query.set('entityId', params.entityId);
  const qs = query.toString();
  return request<WithCount<AuditEventView>>(`/audit-events${qs ? `?${qs}` : ''}`);
}

// ── Sources ──────────────────────────────────────────────────────────────

export type SourceKind = 'local-folder';

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  path: string;
  enabled: boolean;
  intervalMs?: number;
  lastSyncAt?: string;
  lastSyncStatus?: string;
  lastSyncError?: string;
  fileCount: number;
  createdAt: string;
}

export type SourceFileStateStatus = 'ok' | 'failed';

export interface SourceFileState {
  path: string;
  status: SourceFileStateStatus;
  lastError?: string;
  mtimeMs: number;
}

export interface SourceWithFileStates extends Source {
  fileStates: SourceFileState[];
}

export function createSource(input: {
  name: string;
  kind: SourceKind;
  path: string;
  intervalMs?: number;
  enabled?: boolean;
}): Promise<Source> {
  return request<Source>('/sources', { method: 'POST', ...jsonBody(input) });
}

export function listSources(pagination?: {
  skip?: number;
  limit?: number;
}): Promise<WithCount<Source>> {
  const query = new URLSearchParams();
  if (pagination?.skip !== undefined) query.set('skip', String(pagination.skip));
  if (pagination?.limit !== undefined) query.set('limit', String(pagination.limit));
  const qs = query.toString();
  return request<WithCount<Source>>(`/sources${qs ? `?${qs}` : ''}`);
}

export function getSourceById(id: string): Promise<SourceWithFileStates> {
  return request<SourceWithFileStates>(`/sources/${id}`);
}

export function setSourceEnabled(id: string, enabled: boolean): Promise<Source> {
  return request<Source>(`/sources/${id}`, { method: 'PATCH', ...jsonBody({ enabled }) });
}

export function requestSourceSync(id: string): Promise<WorkflowRun> {
  return request<WorkflowRun>(`/sources/${id}/sync`, { method: 'POST' });
}

// ── API keys ─────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
}

// The plaintext `token` lives only here — mint is the sole response shape that carries it.
// Nothing persists it beyond this call; a caller that loses this response has lost the token.
export interface MintedApiKey extends ApiKey {
  token: string;
}

export function mintApiKey(name: string, expiresAt?: string): Promise<MintedApiKey> {
  return request<MintedApiKey>('/api-keys', {
    method: 'POST',
    ...jsonBody(expiresAt ? { name, expiresAt } : { name }),
  });
}

export function listApiKeys(): Promise<WithCount<ApiKey>> {
  return request<WithCount<ApiKey>>('/api-keys');
}

export async function revokeApiKey(id: string): Promise<void> {
  await request<void>(`/api-keys/${id}`, { method: 'DELETE' });
}
