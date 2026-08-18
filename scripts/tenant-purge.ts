import { config } from 'dotenv';
config();

import { MongoClient, GridFSBucket, type Db, type ObjectId } from 'mongodb';

/**
 * Removes ALL of one tenant's data — every collection, plus the GridFS bytes backing document
 * uploads. Driver-level throughout: no Mongoose model, schema default, or plugin (including
 * `tenantScopePlugin`) can silently re-scope or skip a query here.
 *
 *   npx tsx scripts/tenant-purge.ts --tenant <id>          # dry run: reports counts, changes nothing
 *   npx tsx scripts/tenant-purge.ts --tenant <id> --yes    # deletes
 *
 * Collections are enumerated from the database (`db.listCollections()`), not a hardcoded list —
 * a collection added later is covered automatically rather than silently skipped, which is
 * exactly how a purge stops being complete. GridFS is handled separately:
 * `GridFsDocumentStore.put` (src/providers/storage/gridfs-document.store.ts) nests upload
 * metadata as `metadata: { contentType, metadata: doc.metadata }`, so a file's tenantId lands at
 * `metadata.metadata.tenantId`, not a top-level field — the generic per-collection filter would
 * match zero files documents and leave the bytes behind.
 */

const MONGO_DB_URI =
  process.env.MONGO_DB_URI ?? 'mongodb://localhost:27018/evidence-ops?directConnection=true';

interface PurgePlanEntry {
  collection: string;
  filter: Record<string, unknown>;
}

function parseArgs(argv: string[]): { tenantId: string; confirm: boolean } {
  let tenantId: string | undefined;
  let confirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant') {
      tenantId = argv[i + 1];
      i += 1;
    } else if (arg === '--yes') {
      confirm = true;
    }
  }
  if (!tenantId) {
    console.error('usage: tenant-purge.ts --tenant <id> [--yes]');
    console.error('  omit --yes for a dry run: reports per-collection counts, changes nothing');
    process.exit(1);
  }
  return { tenantId, confirm };
}

/**
 * One plan, shared by the dry-run count pass and the real delete pass, so a dry run can never
 * report something the real run wouldn't actually delete.
 */
async function buildPurgePlan(db: Db, tenantId: string): Promise<PurgePlanEntry[]> {
  const collections = await db.listCollections().toArray();
  const plan: PurgePlanEntry[] = [];

  for (const { name } of collections) {
    if (name.endsWith('.chunks') || name.startsWith('system.')) {
      // GridFS chunks carry no tenantId of their own; they're removed via GridFSBucket.delete()
      // below, cascaded from the matching `.files` entry.
      continue;
    }
    if (name.endsWith('.files')) {
      plan.push({ collection: name, filter: { 'metadata.metadata.tenantId': tenantId } });
      continue;
    }
    plan.push({ collection: name, filter: { tenantId } });
  }

  return plan;
}

function reportZeroMatchWarning(total: number): void {
  if (total === 0) {
    console.warn(
      '\nWARNING: no matching documents in any collection — verify the tenant id is correct.',
    );
  }
}

async function dryRun(db: Db, plan: PurgePlanEntry[]): Promise<void> {
  console.log('dry run — no changes made. Re-run with --yes to delete.\n');
  let total = 0;
  for (const { collection, filter } of plan) {
    const count = await db.collection(collection).countDocuments(filter);
    total += count;
    console.log(`  ${collection}: ${count} would be deleted`);
  }
  reportZeroMatchWarning(total);
}

async function purge(db: Db, plan: PurgePlanEntry[]): Promise<void> {
  let total = 0;
  let filesDeleted = 0;
  let versionsMatched = 0;

  for (const { collection, filter } of plan) {
    if (collection.endsWith('.files')) {
      const bucket = new GridFSBucket(db, { bucketName: collection.replace(/\.files$/, '') });
      const files = await db
        .collection<{ _id: ObjectId }>(collection)
        .find(filter, { projection: { _id: 1 } })
        .toArray();
      for (const file of files) {
        await bucket.delete(file._id);
      }
      filesDeleted = files.length;
      total += files.length;
      console.log(`  ${collection}: ${files.length} deleted (cascaded matching .chunks)`);
      continue;
    }

    const result = await db.collection(collection).deleteMany(filter);
    total += result.deletedCount;
    if (collection === 'document_versions') {
      versionsMatched = result.deletedCount;
    }
    console.log(`  ${collection}: ${result.deletedCount} deleted`);
  }

  if (versionsMatched > 0 && filesDeleted === 0) {
    console.warn(
      '\nWARNING: document_versions had matching rows but no GridFS files matched on ' +
        "'metadata.metadata.tenantId' — the stored bytes may not have been purged; investigate " +
        'before treating this as a complete deletion.',
    );
  }

  console.log(`\ndeleted ${total} document(s) total across ${plan.length} collection(s)`);
  reportZeroMatchWarning(total);
}

async function main(): Promise<void> {
  const { tenantId, confirm } = parseArgs(process.argv.slice(2));
  const client = await MongoClient.connect(MONGO_DB_URI);
  try {
    const db = client.db();
    const plan = await buildPurgePlan(db, tenantId);
    console.log(`tenant: ${tenantId}`);
    console.log(`database: ${db.databaseName}\n`);
    if (confirm) {
      await purge(db, plan);
    } else {
      await dryRun(db, plan);
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `✗ ${error.message}` : error);
  process.exitCode = 1;
});
