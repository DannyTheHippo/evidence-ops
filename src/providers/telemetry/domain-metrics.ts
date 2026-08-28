import { metrics } from '@opentelemetry/api';

/**
 * Module-scope meter: safe to call before `instrumentation.ts`'s `NodeSDK.start()` registers a
 * real `MeterProvider` (or in a test that never does) — the OTel API's default global
 * `MeterProvider` returns no-op instruments, so every counter/histogram below is a silent no-op
 * until a real SDK is running, with no test-only branch anywhere in this file or its callers.
 *
 * Every attribute recorded through an instrument below is drawn from a small, fixed set of values
 * (an outcome kind, a rule name, a provider name) — never a tenant id, user id, document id, or
 * any text a user or a model produced. A metrics backend aggregates by attribute value, so a
 * high-cardinality or free-text attribute here is both a cardinality explosion and, for anything
 * derived from evidence content, a privacy leak into a system this codebase does not otherwise
 * send document content to (see `docs/global/threat-model.md`).
 */
const meter = metrics.getMeter('evidence-ops.domain');

/** `GroundingGateService.verify`'s per-claim rejections. `rule` is the `GroundingViolationKind`
 *  that dropped the claim (`grounding-report.type.ts`), a fixed four-value set — never the
 *  claim's own free-text drop reason. A sustained rise here means a model is quietly losing its
 *  grounding, not that any one claim is unusual. */
export const groundingClaimsDroppedCounter = meter.createCounter(
  'evidence_ops.grounding.claims_dropped',
  { description: 'Claims dropped by the grounding verification gate, by violation rule.' },
);

/** `EvidenceRetrievalService.retrieve` calls that returned zero chunks. No attributes: a
 *  sustained rise is the signal regardless of which question triggered it. */
export const emptyRetrievalCounter = meter.createCounter('evidence_ops.retrieval.empty', {
  description: 'Retrieval calls that returned zero chunks.',
});

/** `EvidenceRetrievalService.retrieve` calls where the store returned at least one hit but
 *  `config.retrieval.scoreFloor` dropped every one of them. Distinct from
 *  `emptyRetrievalCounter`, which also fires here (the call still returns zero chunks) but
 *  cannot on its own distinguish "nothing matched" from "a misconfigured floor rejected
 *  everything that matched" — a sustained rise here points at the floor, not the corpus. */
export const scoreFloorRejectedAllCounter = meter.createCounter(
  'evidence_ops.retrieval.score_floor_rejected_all',
  { description: 'Retrieval calls where the score floor dropped every hit the store returned.' },
);

/** A durable workflow run recorded as failed — currently `IngestionService`'s ingestion-workflow
 *  failure recording only, since the answer-question workflow deliberately never hand-rolls a
 *  failed row of its own (Temporal is that run's system of record; see
 *  `answer-persistence.service.ts`'s own doc comment on why). */
export const workflowRunFailedCounter = meter.createCounter('evidence_ops.workflow_run.failed', {
  description: 'Durable workflow runs recorded as failed.',
});

/** `ConflictsService.recordResolution`'s `timed_out` branch: an approval gate that reached its
 *  wait with no human decision. `ruleFired` is the fixed three-value `ConflictRuleFired` the
 *  survivorship policy proposed before the wait began. An approval timing out means a human never
 *  came — an operational fact, not a technical error. */
export const approvalTimeoutCounter = meter.createCounter('evidence_ops.approval.timeout', {
  description: 'Approval gates that timed out with no human decision.',
});

/** Per-call model spend, recorded by `MetricsModelProvider` on every call that actually reaches
 *  the base provider. `provider`/`taskClass` are both small, fixed sets
 *  (`ModelProviderInfo.provider`, `TaskClass`). */
export const modelCostHistogram = meter.createHistogram('evidence_ops.model.cost_usd', {
  description: 'Per-call model cost in USD.',
  unit: 'usd',
});
