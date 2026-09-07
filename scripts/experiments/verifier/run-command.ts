import 'dotenv/config';

import { getConnectionToken } from '@nestjs/mongoose';
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection } from 'mongoose';
import { bootstrapEvalApp, closeEvalApp } from '../../../eval/bootstrap';
import { sanitizeEvidenceText } from '../../../src/features/evidence/ingestion/sanitize-evidence-text';
import { ClaimVerificationService } from '../../../src/features/evidence/qa/claim-verification.service';
import { EvidenceRetrievalService } from '../../../src/features/evidence/qa/evidence-retrieval.service';
import {
  VERIFY_CLAIMS_CLAIM_MAX_LENGTH,
  VERIFY_CLAIMS_MAX_CLAIMS,
} from '../../../src/mcp/mcp-tools';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../../../src/providers/model/model-provider.interface';
import { assertAtlasSearchSupported } from '../../../src/providers/retrieval/atlas-search-capability.util';
import { assertRequiredSearchIndexesExist } from '../../../src/providers/retrieval/required-search-indexes.util';
import { formatPromptLabel } from '../../../src/shared/utils/format-prompt-label.util';
import { draftClaims } from './draft-claims';
import { loadCorpus } from './load-corpus';
import { runExperiment, WORKSHEET_ARTEFACT } from './run-experiment';

/** The shape `cli.ts` loads this module under, without importing its value graph. */
export type RunCommandModule = {
  readonly runCommand: (options: RunCommandOptions) => Promise<void>;
};

export interface RunCommandOptions {
  readonly tenantId: string;
  readonly claimsPerDocument: number;
  readonly seed: number;
  readonly outputRoot: string;
  readonly runId?: string;
}

/** Mirrors `eval/run.ts`'s provenance stamp: a results file whose label names a commit the run did
 *  not execute is worse than one labelled `unknown`. Fails OPEN — this is a label, not a gate. */
function gitSha(): string {
  try {
    const sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty =
      execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

/**
 * The paid half of the experiment: boot the real DI graph over an already-ingested corpus, draft
 * claims about it, put them through `ClaimVerificationService.verifyClaims`, and write the run's
 * artefacts under `<outputRoot>/runs/<runId>/`.
 */
export async function runCommand(options: RunCommandOptions): Promise<void> {
  const outputRoot = path.resolve(options.outputRoot);
  const sha = gitSha();
  const runId = options.runId ?? `${sha}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = path.join(outputRoot, 'runs', runId);
  await mkdir(runDir, { recursive: true });

  const app = await bootstrapEvalApp({
    // Read-through: a re-run after a mid-run failure replays what was already paid for and calls
    // the model only for what is genuinely new.
    cacheMode: 'record',
    modelCacheDir: path.join(outputRoot, 'cache', 'model'),
    embeddingCacheDir: path.join(outputRoot, 'cache', 'embedding'),
  });

  try {
    const connection = app.get<Connection>(getConnectionToken());
    if (!connection.db) {
      throw new Error('verifier experiment: Mongo connection has no active database handle');
    }
    // Before any model or embedding call, for the reason `eval/run.ts` states at its own copy of
    // these two guards: a server that cannot serve $search/$vectorSearch, or an index set that
    // silently lost its files, turns every claim into `no_evidence_retrieved` — a fabricated
    // gate-failure rate rather than a loud stop.
    await assertAtlasSearchSupported(connection.db);
    await assertRequiredSearchIndexesExist(connection.db);

    const { documents, filenameByDocVersionId } = await loadCorpus(app, options.tenantId);
    console.log(
      `verifier: corpus for tenant '${options.tenantId}' — ${documents.length} document(s)`,
    );

    const modelProvider = app.get<ModelProvider>(MODEL_PROVIDER);
    const claimVerificationService = app.get(ClaimVerificationService);
    const evidenceRetrievalService = app.get(EvidenceRetrievalService);

    const record = await runExperiment(
      documents,
      {
        draftForDocument: (document, passOrdinal) =>
          draftClaims(modelProvider, {
            document,
            statementCount: options.claimsPerDocument,
            maxStatementLength: VERIFY_CLAIMS_CLAIM_MAX_LENGTH,
            tenantId: options.tenantId,
            passOrdinal,
          }),
        verifyBatch: (statements) =>
          claimVerificationService.verifyClaims({
            claims: statements,
            tenantId: options.tenantId,
            requestedBy: { kind: 'user', id: 'experiment:verifier' },
          }),
        // The same transform `ClaimVerificationService.verifyOneClaim` applies before retrieving,
        // so the worksheet shows the hits the gate saw rather than a different query's.
        retrieveContext: (statement) =>
          evidenceRetrievalService.retrieve({
            questionText: formatPromptLabel(sanitizeEvidenceText(statement)),
            tenantId: options.tenantId,
          }),
        writeArtefact: (filename, content) =>
          writeFile(path.join(runDir, filename), content, 'utf-8'),
        log: (message) => console.log(`verifier: ${message}`),
      },
      {
        runId,
        gitSha: sha,
        tenantId: options.tenantId,
        maxBatchSize: VERIFY_CLAIMS_MAX_CLAIMS,
        seed: options.seed,
        filenameByDocVersionId,
      },
    );

    console.log(`verifier: wrote ${runDir}`);
    console.log(
      `verifier: ${record.totalClaims} claim(s), ${record.gateFailureCount} gate failure(s), ` +
        `bar 1 ${record.bar1.met ? 'MET' : 'MISSED'} at ${(record.bar1.observed * 100).toFixed(1)}%`,
    );
    console.log(
      `verifier: fill ${path.join(runDir, WORKSHEET_ARTEFACT)}, then run ` +
        `'npm run experiment:verifier -- summarize --run ${runDir}'`,
    );
  } finally {
    await closeEvalApp(app);
  }
}
