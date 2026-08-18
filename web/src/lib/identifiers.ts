import type { WorkflowRunType } from '../api/client';

/**
 * Rendering machine identifiers for a reader. Digests and uuids are the product's evidence trail,
 * so they stay on screen and stay copyable — but a raw 64-character digest or a bare uuid tells a
 * reader nothing at a glance. Each helper here shortens or names one, leaving the full value for a
 * `title` attribute beside it.
 */

const WORKFLOW_TYPE_LABELS: Record<WorkflowRunType, string> = {
  'resolve-conflict': 'Conflict resolution',
  'sync-source': 'Source sync',
};

/** The name a run is listed under. `WorkflowRun.workflowId` is a bare `randomUUID()`, so the type
 * is the only field that says what a run actually is. Falls back for rows the API wrote before it
 * recorded a type. */
export function workflowTypeLabel(workflowType?: WorkflowRunType): string {
  return workflowType ? WORKFLOW_TYPE_LABELS[workflowType] : 'Workflow run';
}

/** Head and tail of a content digest, e.g. `3f9a1c04…7b2e`. A value no longer than the 13
 * characters the truncated form occupies is returned whole — shortening it would add an ellipsis
 * while hiding nothing, and for a short id can repeat characters it already showed. */
export function truncateSha256(sha256: string): string {
  return sha256.length > 13 ? `${sha256.slice(0, 8)}…${sha256.slice(-4)}` : sha256;
}

/** Leading segment of an opaque id (uuid, ObjectId), left whole when already short. */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
