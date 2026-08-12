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
  await request<void>('/auth/logout', { method: 'POST' });
  clearSession();
}

export function getMe(): Promise<Me> {
  return request<Me>('/auth/me');
}

// ── Documents ────────────────────────────────────────────────────────────

export type DocumentSourceKind = 'pdf' | 'docx' | 'xlsx';
export type DocumentVersionIngestionStatus = 'pending' | 'completed';

export interface DocumentVersion {
  id: string;
  versionNumber: number;
  sha256: string;
  sizeBytes: number;
  ingestionStatus: DocumentVersionIngestionStatus;
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
  if (options?.title) formData.append('title', options.title);
  return request<EvidenceDocument>('/documents', { method: 'POST', body: formData });
}

export function listDocuments(): Promise<WithCount<EvidenceDocument>> {
  return request<WithCount<EvidenceDocument>>('/documents');
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
  | { kind: 'xlsx-cell'; extractorVersion: string; sheetName: string; cell: string };

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

export interface Answer {
  id: string;
  questionText: string;
  runStatus: AnswerRunStatus;
  // Present only once runStatus is 'completed' — never render this as a final outcome before
  // then (see qa.controller.ts / answer.response.dto.ts).
  outcome?: AnswerOutcome;
  claimCoverage?: number;
  citations: Citation[];
  conflictIds: string[];
  createdAt: string;
  // QA synthesis spend only — not embedding or extraction spend. Present only once runStatus is
  // 'completed', same gate as outcome above.
  usage?: { promptTokens: number; completionTokens: number; costUsd: number };
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

export interface Conflict {
  id: string;
  factKey: ConflictingFactKey;
  factIds: string[];
  values: ConflictValue[];
  magnitude: number;
  status: ConflictStatus;
  createdAt: string;
}

export function listConflicts(params?: { limit?: number }): Promise<WithCount<Conflict>> {
  return request<WithCount<Conflict>>(
    params?.limit !== undefined ? `/conflicts?limit=${params.limit}` : '/conflicts',
  );
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

export function listApprovals(): Promise<WithCount<Approval>> {
  return request<WithCount<Approval>>('/approvals');
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

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  currentStep?: string;
  errorMessage?: string;
  createdAt: string;
}

export function getWorkflowRunById(id: string): Promise<WorkflowRun> {
  return request<WorkflowRun>(`/workflow-runs/${id}`);
}

export function listWorkflowRuns(params: { workflowId: string }): Promise<WithCount<WorkflowRun>> {
  return request<WithCount<WorkflowRun>>(
    `/workflow-runs?workflowId=${encodeURIComponent(params.workflowId)}`,
  );
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
