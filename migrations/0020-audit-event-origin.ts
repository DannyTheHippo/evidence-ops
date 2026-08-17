import type { Db } from 'mongodb';

const COLLECTION = 'audit_events';
const API_ORIGIN = 'api';

/**
 * `AuditEvent.origin` (added in `audit-event.schema.ts`) needs a backfill, not just a schema
 * default — same reasoning as `0017-survivorship-fields.ts`: Mongoose applies `@Prop({ default })`
 * only to a document it constructs, never to one already on disk from before the field existed.
 * Every pre-existing row is factually `'api'`: the MCP surface wrote no audit rows at all until
 * this field existed, so labelling the whole backlog as non-MCP states what happened rather than
 * guessing at it.
 *
 * `toolName`/`refusalReason` are deliberately not backfilled: both are set only on rows the MCP
 * `tools/call` boundary writes, and absence on every other row is the correct reading.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .updateMany({ origin: { $exists: false } }, { $set: { origin: API_ORIGIN } });
};

export const down = async (db: Db): Promise<void> => {
  // Scoped to `origin: API_ORIGIN`, matching `0017-survivorship-fields.ts`'s reasoning: an
  // unconditional `$unset` would also strip `'mcp'` from rows written after this migration ran,
  // and re-running `up` would then relabel an MCP call as an API one.
  await db.collection(COLLECTION).updateMany({ origin: API_ORIGIN }, { $unset: { origin: '' } });
};
