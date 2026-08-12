import type { Db } from 'mongodb';

const DOCUMENTS_COLLECTION = 'documents';
const DOCUMENTS_INDEX = 'documents_tenantId_createdAt';

const DOCUMENT_VERSIONS_COLLECTION = 'document_versions';
const DOCUMENT_VERSIONS_INDEX = 'document_versions_tenantId_documentId_versionNumber';

const ANSWERS_COLLECTION = 'answers';
const ANSWERS_INDEX = 'answers_tenantId_createdAt';

const WORKFLOW_RUNS_COLLECTION = 'workflow_runs';
const WORKFLOW_RUNS_INDEX = 'workflow_runs_tenantId_createdAt';

const AUDIT_EVENTS_COLLECTION = 'audit_events';
const AUDIT_EVENTS_INDEX = 'audit_events_tenantId_createdAt';

/**
 * `0006-grounding-check-chunk-scoped-indexes.ts` and `0009-approvals-indexes.ts` already gave
 * `extracted_facts`, `conflicts`, and `approvals` a tenant-leading compound index; the five
 * collections here were the ones still missing one. `tenantId` leads in every case for the same
 * reason as those two migrations: every real query scopes by tenant first, so it is the equality
 * field a compound index should put first.
 *
 * `{ tenantId: 1, createdAt: -1 }` backs the "most recent records for tenant X" list query on
 * `documents`, `answers`, `workflow_runs`, and `audit_events` — `createdAt` descending because a
 * listing view reads newest-first. `document_versions` gets `{ tenantId: 1, documentId: 1,
 * versionNumber: 1 }` instead, matching its existing `documentId`-scoped indexes
 * (`0002-document-versions-indexes.ts`) rather than a `createdAt` listing shape, since a version's
 * natural access pattern is "versions of this document, in version order," not a tenant-wide feed.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(DOCUMENTS_COLLECTION)
    .createIndex({ tenantId: 1, createdAt: -1 }, { name: DOCUMENTS_INDEX });
  await db
    .collection(DOCUMENT_VERSIONS_COLLECTION)
    .createIndex(
      { tenantId: 1, documentId: 1, versionNumber: 1 },
      { name: DOCUMENT_VERSIONS_INDEX },
    );
  await db
    .collection(ANSWERS_COLLECTION)
    .createIndex({ tenantId: 1, createdAt: -1 }, { name: ANSWERS_INDEX });
  await db
    .collection(WORKFLOW_RUNS_COLLECTION)
    .createIndex({ tenantId: 1, createdAt: -1 }, { name: WORKFLOW_RUNS_INDEX });
  await db
    .collection(AUDIT_EVENTS_COLLECTION)
    .createIndex({ tenantId: 1, createdAt: -1 }, { name: AUDIT_EVENTS_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(DOCUMENTS_COLLECTION).dropIndex(DOCUMENTS_INDEX);
  await db.collection(DOCUMENT_VERSIONS_COLLECTION).dropIndex(DOCUMENT_VERSIONS_INDEX);
  await db.collection(ANSWERS_COLLECTION).dropIndex(ANSWERS_INDEX);
  await db.collection(WORKFLOW_RUNS_COLLECTION).dropIndex(WORKFLOW_RUNS_INDEX);
  await db.collection(AUDIT_EVENTS_COLLECTION).dropIndex(AUDIT_EVENTS_INDEX);
};
