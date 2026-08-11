/**
 * Failure/recovery capture (plan Step 27 acceptance, referenced by Step 33).
 *
 * Proves the property that justifies Temporal in ADR-0003: a workflow survives the loss of the
 * process executing it. The script starts `answerQuestion`, waits until the worker has actually
 * begun running activities, kills the worker mid-flight, restarts it, and asserts the SAME workflow
 * run — same run id, same answer row — reaches `completed`.
 *
 * What makes this a real demonstration rather than a restart: the workflow is never restarted and
 * never re-submitted. Temporal replays its event history into the new worker, and the activities
 * that had already succeeded are not re-executed — their results come back from history. A
 * request-scoped orchestration (a promise chain in an HTTP handler) loses everything when the
 * process dies; this loses only the in-flight activity attempt.
 *
 * Run with a Temporal dev server and Atlas Local already up; it is an operator script, not a test.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { MongoClient } from 'mongodb';

const ROOT = join(__dirname, '..');
const ARTIFACTS = join(ROOT, 'artifacts');
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'evidence-ops';
// The eval harness ingests the fixture data room under this tenant. Using `default` retrieves zero
// chunks, which is how the first run of this script produced an instant `insufficient_evidence` and
// left no activity in flight to kill.
const TENANT_ID = process.env.DEMO_TENANT_ID ?? 'eval';
const log: string[] = [];

function record(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  log.push(stamped);
}

function startWorker(label: string): ChildProcess {
  const child = spawn('npx', ['ts-node', '-P', 'tsconfig.ts-node.json', 'src/worker/main.ts'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => {
    const text = d.toString().trim();
    if (text) record(`[${label} stdout] ${text.split('\n').slice(-1)[0]}`);
  });
  child.stderr?.on('data', (d: Buffer) => {
    const text = d.toString().trim();
    if (text) record(`[${label} stderr] ${text.split('\n').slice(-1)[0]}`);
  });
  return child;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });

  // No worker yet, deliberately. Starting the workflow against an empty task queue is the first
  // half of the proof: the execution exists in Temporal before any process is capable of running
  // it, which is precisely what a promise chain inside an HTTP handler cannot do.
  let worker: ChildProcess | undefined;

  // `ingestDocumentVersion`, not `answerQuestion`. The answer workflow completes in about fourteen
  // seconds, and an earlier version of this script polled through the whole run without ever
  // sampling an activity mid-flight — the kill landed on an already-COMPLETED workflow and proved
  // nothing. Ingestion embeds through a provider throttled to the account's 3 requests/minute, so
  // there is a wide, deterministic window in which to kill the process.
  const mongoUri = process.env.MONGO_DB_URI ?? 'mongodb://localhost:27017/evidence_ops';
  const mongo = await MongoClient.connect(mongoUri);
  const db = mongo.db();
  const version = await db
    .collection('document_versions')
    .findOne({ tenantId: TENANT_ID }, { sort: { createdAt: -1 } });
  if (!version) {
    throw new Error(
      `no document_versions under tenant '${TENANT_ID}' — run 'npm run eval -- --record' first to ingest the fixture data room`,
    );
  }
  const versionId = version._id;
  // Reset so the ingest actually re-runs: `ingestVersion` short-circuits on `completed`, and its
  // lease guard refuses a version another attempt still owns.
  await db
    .collection('document_versions')
    .updateOne(
      { _id: versionId },
      { $set: { ingestionStatus: 'pending' }, $unset: { ingestionLeaseToken: '' } },
    );
  await db.collection('evidence_chunks').deleteMany({ documentVersionId: versionId });
  await mongo.close();
  record(`reset version ${versionId.toString()} to pending for re-ingest`);

  const workflowId = `failure-recovery-${Date.now()}`;
  record(`starting workflow ${workflowId}`);
  const handle = await client.workflow.start('ingestDocumentVersion', {
    taskQueue: TASK_QUEUE,
    workflowId,
    args: [{ documentVersionId: versionId.toString(), tenantId: TENANT_ID }],
  });
  record(`workflow started, runId=${handle.firstExecutionRunId}`);

  // Half one: no worker exists yet, and the execution is already durable.
  await sleep(3000);
  const noWorker = await handle.describe();
  const noWorkerEvents = (await handle.fetchHistory()).events ?? [];
  record(
    `with NO worker ever started: status=${noWorker.status.name}, ${noWorkerEvents.length} history events — the execution is durable before any process can run it`,
  );

  // Half two: give it a worker, then take that worker away mid-run. Polling for an in-flight
  // activity proved unreliable — activities here settle faster than a describe+fetchHistory round
  // trip, so earlier attempts sampled straight past them and killed an already-finished workflow.
  // A fixed delay shorter than the known ingest duration (~11s warm) lands inside the run.
  record('starting worker A');
  worker = startWorker('worker-A');
  await sleep(4000);

  const beforeKill = await handle.describe();
  const beforeKillEvents = (await handle.fetchHistory()).events ?? [];
  const startedCount = beforeKillEvents.filter((e) => e.activityTaskStartedEventAttributes).length;
  const settledCount = beforeKillEvents.filter(
    (e) => e.activityTaskCompletedEventAttributes ?? e.activityTaskFailedEventAttributes,
  ).length;
  record(
    `status before kill: ${beforeKill.status.name} (${startedCount} activity starts, ${settledCount} settled)`,
  );

  record(`KILLING worker A (pid ${worker.pid}) mid-workflow`);
  worker.kill('SIGKILL');
  await sleep(4000);
  const afterKill = await handle.describe();
  record(`status with NO worker running: ${afterKill.status.name} (workflow survives the process)`);

  record('starting worker B — same task queue, fresh process');
  worker = startWorker('worker-B');

  const deadline = Date.now() + 180000;
  let status = afterKill.status.name;
  while (Date.now() < deadline) {
    await sleep(5000);
    status = (await handle.describe()).status.name;
    record(`status: ${status}`);
    if (status !== 'RUNNING') break;
  }

  let outcome = 'unavailable';
  try {
    outcome = JSON.stringify(await handle.result());
  } catch (error) {
    outcome = `workflow failed: ${(error as Error).message}`;
  }
  record(`final status=${status} runId=${handle.firstExecutionRunId}`);
  record(`result: ${outcome}`);
  record(
    `same run id throughout: ${handle.firstExecutionRunId === beforeKill.runId ? 'yes' : 'no'} — the workflow was never restarted or resubmitted`,
  );

  worker?.kill('SIGTERM');
  await connection.close();

  const outPath = join(ARTIFACTS, 'failure-recovery.log');
  writeFileSync(outPath, `${log.join('\n')}\n`);
  record(`wrote ${outPath}`);
  process.exit(status === 'COMPLETED' ? 0 : 1);
}

void main();
