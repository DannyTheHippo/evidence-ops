import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import type { AttestationService } from '../features/evidence/attestations/attestation.service';
import { AttestationSubjectRequiredException } from '../features/evidence/attestations/exceptions/attestations.exception';
import type { ClaimVerificationService } from '../features/evidence/qa/claim-verification.service';
import type { ConflictsService } from '../features/evidence/conflicts/conflicts.service';
import type { LedgerService } from '../features/evidence/ledger/ledger.service';
import {
  SEARCH_EVIDENCE_TOOL_NAME,
  searchEvidenceToolDefinition,
} from '../features/evidence/retrieval/evidence-tools';
import { SUBMIT_EVIDENCE_MAX_BASE64_CHARS } from '../features/evidence/sources/evidence-submission.service';
import type { EvidenceSubmissionService } from '../features/evidence/sources/evidence-submission.service';
import type { QaService } from '../features/evidence/qa/qa.service';
import type { ModelToolDefinition } from '../providers/model/model-provider.interface';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionStep,
} from '../features/platform/authz/types/tool-definition.type';

export const GET_ANSWER_TOOL_NAME = 'get_answer';
export const REQUEST_RESOLUTION_TOOL_NAME = 'request_resolution';
export const ASK_EVIDENCE_TOOL_NAME = 'ask_evidence';
export const VERIFY_CLAIMS_TOOL_NAME = 'verify_claims';
export const SUBMIT_EVIDENCE_TOOL_NAME = 'submit_evidence';
export const LOOKUP_FACT_TOOL_NAME = 'lookup_fact';
export const GET_ATTESTATION_TOOL_NAME = 'get_attestation';

/** The step this process presents to `ToolExecutorService.execute` for every read-only tool call
 *  it proxies — `search_evidence` reused as-is from the retrieval feature
 *  (`buildSearchEvidenceTool` in `../features/evidence/retrieval/evidence-tools.ts`) plus
 *  `get_answer`, `lookup_fact`, and `get_attestation`: all four only ever read this tenant's own
 *  data, scoped by `context.tenantId`. Kept disjoint from `MCP_MUTATE_STEP`/`MCP_SUBMIT_STEP`
 *  below — a read token, a mutating token, and a token that can write new evidence stay
 *  distinguishable in policy because none of the three share a step. */
export const MCP_READ_STEP: ToolExecutionStep = {
  stepId: 'mcp-read',
  allowedTools: [
    SEARCH_EVIDENCE_TOOL_NAME,
    GET_ANSWER_TOOL_NAME,
    LOOKUP_FACT_TOOL_NAME,
    GET_ATTESTATION_TOOL_NAME,
  ],
};

/** The step presented for `submit_evidence` — kept disjoint from every step above for the same
 *  reason `MCP_MUTATE_STEP` is: this tool writes a new document version into the corpus, unlike
 *  anything on `MCP_READ_STEP`, and it must stay separately refusable from `request_resolution`'s
 *  own step (a caller trusted to submit evidence is not thereby trusted to decide a conflict). */
export const MCP_SUBMIT_STEP: ToolExecutionStep = {
  stepId: 'mcp-submit',
  allowedTools: [SUBMIT_EVIDENCE_TOOL_NAME],
};

/** The step presented for `request_resolution`, this surface's only mutating tool. Never carries
 *  a read-only tool — see `MCP_READ_STEP`'s own doc comment for why the split matters to policy. */
export const MCP_MUTATE_STEP: ToolExecutionStep = {
  stepId: 'mcp-mutate',
  allowedTools: [REQUEST_RESOLUTION_TOOL_NAME],
};

/** The step presented for `ask_evidence` — kept disjoint from both steps above rather than folded
 *  into `MCP_READ_STEP`. This tool starts a Temporal workflow and spends model budget the moment
 *  it is called, unlike `search_evidence`/`get_answer`, which only read; a token scoped to read
 *  access must be refusable for starting paid synthesis without also narrowing what those two
 *  tools can do. `mcp-ask`'s own `STEP_MINIMUM_ROLE` entry happens to match `mcp-read`'s Member
 *  floor today, but the two are policed by separate map entries so either can move independently
 *  later. */
export const MCP_ASK_STEP: ToolExecutionStep = {
  stepId: 'mcp-ask',
  allowedTools: [ASK_EVIDENCE_TOOL_NAME],
};

/** The step presented for `verify_claims` — kept disjoint from `MCP_READ_STEP`/`MCP_MUTATE_STEP`/
 *  `MCP_ASK_STEP` for the same reason `MCP_ASK_STEP` is disjoint from the others: this tool calls
 *  the model once per submitted claim and spends model budget the moment it is called, so a token
 *  scoped to search or to asking a question must stay deniable this tool without narrowing what
 *  those tools can do, and vice versa. */
export const MCP_VERIFY_STEP: ToolExecutionStep = {
  stepId: 'mcp-verify',
  allowedTools: [VERIFY_CLAIMS_TOOL_NAME],
};

/**
 * `search_evidence` as this surface advertises it. The handler is `evidence-tools.ts`'s
 * `buildSearchEvidenceTool` unchanged, and `searchEvidenceToolDefinition.inputSchema` is reused as
 * declared there; only the description differs, because what a caller receives differs.
 * `McpServerService` serializes the retrieval result as it stands, so every hit arrives with its
 * full chunk text — the base definition's own description promises only a short snippet, which
 * would understate what this surface actually returns.
 */
export const mcpSearchEvidenceToolDefinition: ModelToolDefinition = {
  ...searchEvidenceToolDefinition,
  description:
    "Search the tenant's evidence corpus for chunks relevant to a query. Returns each matching " +
    'chunk in full — its complete text, its chunkId, and the locator that points back into the ' +
    'source document. There is no separate fetch step on this surface, and no tool for reading a ' +
    'chunk this search did not return.',
};

const getAnswerArgsSchema = z.object({ answerId: z.string().min(1) });
// `.strict()` here (unlike `evidence-tools.ts`'s sibling schema, which feeds a model call rather
// than an advertised `tools/list` entry) so the JSON Schema this surface advertises declares
// `additionalProperties: false` — matching, not merely approximating, the strictness
// `ToolExecutorService.registerTool` enforces on every registered tool regardless.
const getAnswerInputSchema = z4.object({ answerId: z4.string().min(1) }).strict();

export const getAnswerToolDefinition: ModelToolDefinition = {
  name: GET_ANSWER_TOOL_NAME,
  description:
    'Fetch a previously started question by its answerId: run status, the verified answer ' +
    '(once complete), and its citations with their locators. Does not start a new question — ' +
    'use ask_evidence for that, then pass the answerId it returns here.',
  inputSchema: getAnswerInputSchema,
};

/**
 * `get_answer`'s registered handler. `context.actorId`/`context.tenantId` — server-derived from
 * the verified PAT, never from `args` — are the only identity `QaService.getAnswerById` ever
 * sees; `answerId` is the sole model-supplied argument, and a cross-tenant id 404s exactly like a
 * missing one (see that method's own doc comment), so no argument can widen which tenant's
 * answers are reachable.
 */
export function buildGetAnswerTool(qaService: QaService): ToolDefinition {
  return {
    name: GET_ANSWER_TOOL_NAME,
    argsSchema: getAnswerArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { answerId } = args as { answerId: string };
      return qaService.getAnswerById(answerId, context.actorId, context.tenantId);
    },
  };
}

/**
 * Sole length bound on `ask_evidence`'s `question` — `StartQuestionRequestDto` carries no
 * `@MaxLength`, and the MCP process runs no `ValidationPipe` at all (`src/mcp/mcp.module.ts`), so
 * without this the model-supplied string this schema validates would be unbounded before it ever
 * reaches `QaService.startQuestion`.
 */
export const ASK_EVIDENCE_QUESTION_MAX_LENGTH = 4000;

const askEvidenceArgsSchema = z.object({
  question: z.string().min(1).max(ASK_EVIDENCE_QUESTION_MAX_LENGTH),
});
// `.strict()` for the same reason `getAnswerInputSchema` carries it above — this shape is
// advertised via `tools/list`, not only fed to a model call.
const askEvidenceInputSchema = z4
  .object({ question: z4.string().min(1).max(ASK_EVIDENCE_QUESTION_MAX_LENGTH) })
  .strict();

export const askEvidenceToolDefinition: ModelToolDefinition = {
  name: ASK_EVIDENCE_TOOL_NAME,
  description:
    'Start a new question against the evidence corpus and return a handle to it — ' +
    '{ answerId, runStatus } — without waiting for an answer. The gated synthesis pipeline this ' +
    'starts can take several minutes to complete. Poll get_answer with the returned answerId to ' +
    'check progress, at an interval of roughly 10-15 seconds: this surface budgets 60 calls per ' +
    'actor per minute, so polling every couple of seconds spends most of that budget on repeated ' +
    'checks rather than leaving room for other calls.',
  inputSchema: askEvidenceInputSchema,
};

/**
 * `ask_evidence`'s registered handler — delegates to `QaService.startQuestion`, the exact method
 * `QaController.startQuestion` (`POST /questions`) calls, so a question started over MCP runs
 * through the same queued `Answer` row, Temporal workflow start, and `qa.question.started` audit
 * write as the HTTP path. `context.actorId`/`context.role`/`context.tenantId` — server-derived
 * from the verified PAT, never from `args` — are the identity `startQuestion` is called with;
 * `question` is the sole model-supplied argument. Returns a handle only, `{ answerId, runStatus }`
 * (`StartQuestionResult.id` renamed to `answerId` to match the argument name `get_answer` takes),
 * never the answer itself — see `askEvidenceToolDefinition`'s description for why, and
 * `buildGetAnswerTool` for the poll.
 */
export function buildAskEvidenceTool(qaService: QaService): ToolDefinition {
  return {
    name: ASK_EVIDENCE_TOOL_NAME,
    argsSchema: askEvidenceArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { question } = args as { question: string };
      const { id, runStatus } = await qaService.startQuestion({
        questionText: question,
        actorId: context.actorId,
        role: context.role,
        tenantId: context.tenantId,
      });
      return { answerId: id, runStatus };
    },
  };
}

const requestResolutionArgsSchema = z.object({
  conflictId: z.string().min(1),
  winningFactId: z.string().min(1),
});
// `.strict()` for the same reason `getAnswerInputSchema` carries it above — this shape is
// advertised via `tools/list`, not only fed to a model call.
const requestResolutionInputSchema = z4
  .object({ conflictId: z4.string().min(1), winningFactId: z4.string().min(1) })
  .strict();

export const requestResolutionToolDefinition: ModelToolDefinition = {
  name: REQUEST_RESOLUTION_TOOL_NAME,
  description:
    'Propose winningFactId as the correct value for an open conflict. This only starts a ' +
    "workflow that parks on a human's durable approval — it never decides the conflict itself, " +
    'and this surface has no tool that can. Poll the returned run to see whether a human has ' +
    'approved, rejected, or not yet acted on the proposal.',
  inputSchema: requestResolutionInputSchema,
};

/**
 * `request_resolution`'s registered handler — delegates to `ConflictsService.requestResolution`,
 * the exact method `POST /conflicts/:id/resolution-requests` calls, so conflict loading, proposal
 * validation, and workflow starting run through the one implementation both surfaces share.
 * `context.actorId`/`context.tenantId` scope the request the same way `get_answer` scopes its
 * lookup; `conflictId`/`winningFactId` are the only model-supplied arguments. `requestedBy` takes
 * `context.email` when the verified PAT resolved one, falling back to `context.actorId` only when
 * it did not — matching what `RequestConflictResolutionRequestDto`'s REST path already shows a
 * reviewer. `origin: 'mcp'` is a fixed literal, not read from `context`: it names this handler as
 * the caller, so the approver sees a proposal that reached the workflow through the AI-reachable
 * surface rather than an interactive session, per ADR-0014 § Approvals.
 */
export function buildRequestResolutionTool(conflictsService: ConflictsService): ToolDefinition {
  return {
    name: REQUEST_RESOLUTION_TOOL_NAME,
    argsSchema: requestResolutionArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { conflictId, winningFactId } = args as {
        conflictId: string;
        winningFactId: string;
      };
      return conflictsService.requestResolution({
        conflictId,
        winningFactId,
        actorId: context.actorId,
        requestedBy: context.email ?? context.actorId,
        tenantId: context.tenantId,
        origin: 'mcp',
      });
    },
  };
}

/** Upper bound on how many claims one `verify_claims` call accepts. `ClaimVerificationService`
 *  runs claims sequentially, never fanned out (see that method's own doc comment on why), so an
 *  unbounded array would let one call chain an unbounded number of sequential model calls. */
export const VERIFY_CLAIMS_MAX_CLAIMS = 10;

/** Per-claim length bound, mirroring `ASK_EVIDENCE_QUESTION_MAX_LENGTH`'s role for `ask_evidence`
 *  — this channel runs no `ValidationPipe`, so without this the model-supplied claim strings this
 *  schema validates would be unbounded before ever reaching `ClaimVerificationService`. */
export const VERIFY_CLAIMS_CLAIM_MAX_LENGTH = 1000;

const verifyClaimsArgsSchema = z.object({
  claims: z
    .array(z.string().min(1).max(VERIFY_CLAIMS_CLAIM_MAX_LENGTH))
    .min(1)
    .max(VERIFY_CLAIMS_MAX_CLAIMS),
});
// `.strict()` for the same reason `getAnswerInputSchema` carries it above — this shape is
// advertised via `tools/list`, not only fed to a model call.
const verifyClaimsInputSchema = z4
  .object({
    claims: z4
      .array(z4.string().min(1).max(VERIFY_CLAIMS_CLAIM_MAX_LENGTH))
      .min(1)
      .max(VERIFY_CLAIMS_MAX_CLAIMS),
  })
  .strict();

export const verifyClaimsToolDefinition: ModelToolDefinition = {
  name: VERIFY_CLAIMS_TOOL_NAME,
  description:
    "Check claims you have drafted yourself against this tenant's evidence corpus, one verdict " +
    'per claim. A "grounded" verdict means supporting evidence was located in the corpus and the ' +
    'citation was mechanically verified against it — it is not an assertion that the claim is ' +
    'true, only that this corpus supports it. Most claims submitted here will legitimately come ' +
    'back "not_grounded"; that is the expected, common outcome for a claim this corpus does not ' +
    'support, not a sign of a malfunction. There is no aggregate score or pass/fail — each claim' +
    "'s verdict stands on its own.",
  inputSchema: verifyClaimsInputSchema,
};

/**
 * `verify_claims`'s registered handler — delegates to `ClaimVerificationService.verifyClaims`.
 * `context.tenantId` — server-derived from the verified PAT, never from `args` — is the sole
 * tenant scope the call runs under; `claims` is the only model-supplied argument. Returns
 * `VerifyClaimsResult` exactly as `ClaimVerificationService` produces it: the fixed advisory, one
 * `VerifyClaimResult` per submitted claim in submission order, and the id of the run's persisted
 * `Verification` row. `requestedBy` is `{ kind: 'pat', id: context.actorId }` — this surface is
 * only ever reached by a verified personal access token, never a signed-in user session.
 */
export function buildVerifyClaimsTool(
  claimVerificationService: ClaimVerificationService,
): ToolDefinition {
  return {
    name: VERIFY_CLAIMS_TOOL_NAME,
    argsSchema: verifyClaimsArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { claims } = args as { claims: string[] };
      return claimVerificationService.verifyClaims({
        claims,
        tenantId: context.tenantId,
        requestedBy: { kind: 'pat', id: context.actorId },
      });
    },
  };
}

/** Length bounds on `submit_evidence`'s string arguments — this channel runs no `ValidationPipe`,
 *  so without these the model-supplied strings this schema validates would be unbounded before
 *  ever reaching `EvidenceSubmissionService.submit`. `contentBase64`'s own cap
 *  (`SUBMIT_EVIDENCE_MAX_BASE64_CHARS`) is imported from that service rather than redeclared here,
 *  so the schema chokepoint and the service's own defence-in-depth check can never drift apart. */
export const SUBMIT_EVIDENCE_FILENAME_MAX_LENGTH = 255;
export const SUBMIT_EVIDENCE_MIME_TYPE_MAX_LENGTH = 255;
export const SUBMIT_EVIDENCE_SOURCE_LABEL_MAX_LENGTH = 200;

const submitEvidenceArgsSchema = z.object({
  filename: z.string().min(1).max(SUBMIT_EVIDENCE_FILENAME_MAX_LENGTH),
  mimeType: z.string().min(1).max(SUBMIT_EVIDENCE_MIME_TYPE_MAX_LENGTH),
  contentBase64: z.string().min(1).max(SUBMIT_EVIDENCE_MAX_BASE64_CHARS),
  sourceLabel: z.string().min(1).max(SUBMIT_EVIDENCE_SOURCE_LABEL_MAX_LENGTH).optional(),
});
// `.strict()` for the same reason `getAnswerInputSchema` carries it above — this shape is
// advertised via `tools/list`, not only fed to a model call.
const submitEvidenceInputSchema = z4
  .object({
    filename: z4.string().min(1).max(SUBMIT_EVIDENCE_FILENAME_MAX_LENGTH),
    mimeType: z4.string().min(1).max(SUBMIT_EVIDENCE_MIME_TYPE_MAX_LENGTH),
    contentBase64: z4.string().min(1).max(SUBMIT_EVIDENCE_MAX_BASE64_CHARS),
    sourceLabel: z4.string().min(1).max(SUBMIT_EVIDENCE_SOURCE_LABEL_MAX_LENGTH).optional(),
  })
  .strict();

export const submitEvidenceToolDefinition: ModelToolDefinition = {
  name: SUBMIT_EVIDENCE_TOOL_NAME,
  description:
    `Submit a file's bytes (base64-encoded, up to ${SUBMIT_EVIDENCE_MAX_BASE64_CHARS} base64 ` +
    "characters) into this tenant's evidence corpus — pdf, docx, xlsx, pptx, csv, tsv, txt, md, " +
    'eml, or html. The file enters the exact same ingest pipeline a browser upload does: content-' +
    'type verification against the actual bytes, deduplication by content hash, and asynchronous ' +
    'extraction. Returns { documentId, documentVersionId, sha256, ingestionStatus, isNewVersion, ' +
    'sourceId } — poll extraction status by document, not through get_answer.',
  inputSchema: submitEvidenceInputSchema,
};

/**
 * `submit_evidence`'s registered handler — delegates to `EvidenceSubmissionService.submit`, the
 * same base64-shape/content-type/dedupe gate a browser upload runs through via
 * `DocumentsService.uploadVersion`. `context.tenantId` — server-derived from the verified PAT,
 * never from `args` — is the sole tenant scope the call runs under; `filename`, `mimeType`,
 * `contentBase64`, and `sourceLabel` are the only model-supplied arguments. No approval gate: REST
 * upload parity, per `EvidenceSubmissionService`'s own doc comment.
 */
export function buildSubmitEvidenceTool(service: EvidenceSubmissionService): ToolDefinition {
  return {
    name: SUBMIT_EVIDENCE_TOOL_NAME,
    argsSchema: submitEvidenceArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { filename, mimeType, contentBase64, sourceLabel } = args as {
        filename: string;
        mimeType: string;
        contentBase64: string;
        sourceLabel?: string;
      };
      return service.submit({
        filename,
        mimeType,
        contentBase64,
        sourceLabel,
        tenantId: context.tenantId,
      });
    },
  };
}

/** Length bounds on `lookup_fact`'s string arguments, mirroring `ASK_EVIDENCE_QUESTION_MAX_LENGTH`'s
 *  role for `ask_evidence` — this channel runs no `ValidationPipe`, so without these the
 *  model-supplied strings this schema validates would be unbounded before ever reaching
 *  `LedgerService.resolveValue`. */
export const LOOKUP_FACT_ENTITY_MAX_LENGTH = 200;
export const LOOKUP_FACT_MEASURE_MAX_LENGTH = 100;
export const LOOKUP_FACT_PERIOD_MAX_LENGTH = 40;

const lookupFactArgsSchema = z.object({
  entity: z.string().min(1).max(LOOKUP_FACT_ENTITY_MAX_LENGTH),
  measure: z.string().min(1).max(LOOKUP_FACT_MEASURE_MAX_LENGTH),
  period: z.string().min(1).max(LOOKUP_FACT_PERIOD_MAX_LENGTH).optional(),
});
// `.strict()` for the same reason `getAnswerInputSchema` carries it above — this shape is
// advertised via `tools/list`, not only fed to a model call.
const lookupFactInputSchema = z4
  .object({
    entity: z4.string().min(1).max(LOOKUP_FACT_ENTITY_MAX_LENGTH),
    measure: z4.string().min(1).max(LOOKUP_FACT_MEASURE_MAX_LENGTH),
    period: z4.string().min(1).max(LOOKUP_FACT_PERIOD_MAX_LENGTH).optional(),
  })
  .strict();

export const lookupFactToolDefinition: ModelToolDefinition = {
  name: LOOKUP_FACT_TOOL_NAME,
  description:
    "Resolve one (entity, measure, period) cell of this tenant's fact ledger — the same lookup " +
    "GET /ledger/resolve performs, returned in the same shape. state is one of 'single' (one " +
    "confirmed fact, no conflict), 'adjudicated' (a conflict a human has resolved), 'conflicted' " +
    "(an open conflict, no resolution yet), or 'unknown' (no confirmed fact for this cell, or the " +
    "measure itself is not confirmed). period is optional; omit it to resolve the ledger's " +
    'default period for that entity and measure.',
  inputSchema: lookupFactInputSchema,
};

/**
 * `lookup_fact`'s registered handler — delegates to `LedgerService.resolveValue`, returned as-is:
 * the same service result `GET /ledger/resolve` serializes into `LedgerResolutionResponseDto`.
 * `context.tenantId` — server-derived from the verified PAT, never from `args` — is the sole
 * tenant scope the call runs under; `entity`, `measure`, and `period` are the only model-supplied
 * arguments.
 */
export function buildLookupFactTool(ledgerService: LedgerService): ToolDefinition {
  return {
    name: LOOKUP_FACT_TOOL_NAME,
    argsSchema: lookupFactArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { entity, measure, period } = args as {
        entity: string;
        measure: string;
        period?: string;
      };
      return ledgerService.resolveValue({ tenantId: context.tenantId, entity, measure, period });
    },
  };
}

/** Length bound on `get_attestation`'s id arguments — both `Answer` and `Verification` ids are
 *  Mongo ObjectId hex strings today, well under this cap, but the cap guards the shape of the
 *  argument the schema validates rather than assuming callers only ever send a valid ObjectId. */
export const ATTESTATION_ID_MAX_LENGTH = 64;

const getAttestationArgsSchema = z.object({
  answerId: z.string().min(1).max(ATTESTATION_ID_MAX_LENGTH).optional(),
  verificationId: z.string().min(1).max(ATTESTATION_ID_MAX_LENGTH).optional(),
});
// `.strict()` for the same reason `getAnswerInputSchema` carries it above — this shape is
// advertised via `tools/list`, not only fed to a model call.
const getAttestationInputSchema = z4
  .object({
    answerId: z4.string().min(1).max(ATTESTATION_ID_MAX_LENGTH).optional(),
    verificationId: z4.string().min(1).max(ATTESTATION_ID_MAX_LENGTH).optional(),
  })
  .strict();

export const getAttestationToolDefinition: ModelToolDefinition = {
  name: GET_ATTESTATION_TOOL_NAME,
  description:
    'Export a tamper-evident attestation bundle for a completed answer or a verification run — ' +
    'exactly one of answerId or verificationId is required, never both, never neither. ' +
    'integrity.contentHash is a sha256 over the canonical JSON of everything else in the bundle: ' +
    'it proves the bundle has not changed since export, not who produced it — there is no ' +
    'signing key, so this is a hash, not a signature.',
  inputSchema: getAttestationInputSchema,
};

/**
 * `get_attestation`'s registered handler — delegates to `AttestationService.exportForAnswer`/
 * `exportForVerification` depending on which id argument is present. `context.tenantId` —
 * server-derived from the verified PAT, never from `args` — is the sole tenant scope the call
 * runs under; `answerId`/`verificationId` are the only model-supplied arguments. The schema alone
 * cannot express "exactly one of two optional keys" (`ToolExecutorService`'s `applyStrictRecursively`
 * does not cover `ZodUnion` or refinements — see that method's own doc comment), so the handler
 * enforces it: both present or both absent throws `AttestationSubjectRequiredException` before
 * either export method runs.
 */
export function buildGetAttestationTool(service: AttestationService): ToolDefinition {
  return {
    name: GET_ATTESTATION_TOOL_NAME,
    argsSchema: getAttestationArgsSchema,
    handler: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
      const { answerId, verificationId } = args as {
        answerId?: string;
        verificationId?: string;
      };
      if ((answerId === undefined) === (verificationId === undefined)) {
        throw new AttestationSubjectRequiredException(
          'Exactly one of answerId or verificationId is required',
        );
      }
      return answerId !== undefined
        ? service.exportForAnswer(answerId, context.tenantId)
        : service.exportForVerification(verificationId as string, context.tenantId);
    },
  };
}
