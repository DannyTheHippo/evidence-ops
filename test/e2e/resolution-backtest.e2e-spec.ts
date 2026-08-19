import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import {
  Conflict,
  ConflictDocument,
} from '../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  DocumentDocument,
} from '../../src/database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../src/database/schemas/evidence/document-version/document-version.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
  type FactKey,
  type FactValue,
} from '../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { groupKey } from '../../src/features/evidence/conflicts/detect-conflicts';
import * as resolveConflictPolicyModule from '../../src/features/evidence/conflicts/resolve-conflict-policy';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface ResolutionBacktestResultBody {
  conflictId: string;
  factKey: FactKey;
  verdict: string;
  recordedOutcome: string;
  recordedWinningFactId?: string;
  replayedRuleFired?: string;
  replayedWinningFactId?: string;
  unscorableReason?: string;
}

interface ResolutionBacktestBody {
  results: ResolutionBacktestResultBody[];
  agreed: number;
  disagreed: number;
  silent: number;
  unscorable: number;
  agreementRate: number | null;
}

describe('Resolution backtest (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let tenantId: string;
  let conflictModel: Model<ConflictDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;
  let documentModel: Model<DocumentDocument>;

  beforeAll(async () => {
    app = await createTestApp();
    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
    extractedFactModel = app.get<Model<ExtractedFactDocument>>(getModelToken(ExtractedFact.name));
    documentVersionModel = app.get<Model<DocumentVersionDocument>>(
      getModelToken(DocumentVersion.name),
    );
    documentModel = app.get<Model<DocumentDocument>>(getModelToken(Document.name));

    const admin = await registerTestUser(app, {
      email: 'resolution-backtest-e2e@example.com',
      password: 'correct-horse-battery',
    });
    cookie = admin.cookie;
    tenantId = admin.tenantId;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  const seedFact = (
    factKey: FactKey,
    value: FactValue,
    chunkId: string,
    forTenantId: string = tenantId,
  ) =>
    extractedFactModel.create({
      factKey,
      groupKeyNormalized: groupKey(factKey),
      tenantId: forTenantId,
      value,
      rawText: `${value.amount}${value.unit}`,
      confidence: 0.9,
      extractionMethod: 'llm',
      chunkId,
      documentVersionId: new Types.ObjectId(),
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'A1' },
    });

  describe('GET /conflicts/resolution-backtest', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get(
        '/api/v1/conflicts/resolution-backtest',
      );

      expect(response.status).toBe(401);
    });

    it('returns an empty report with a null agreementRate for a tenant with no resolved conflicts, exposing the exact top-level key set', async () => {
      const isolatedTenant = await registerTestUser(app, {
        email: 'resolution-backtest-empty-e2e@example.com',
        password: 'correct-horse-battery',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts/resolution-backtest')
        .set('Cookie', isolatedTenant.cookie);
      const body = response.body as ResolutionBacktestBody;

      expect(response.status).toBe(200);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body).sort()).toEqual(
        ['results', 'agreed', 'disagreed', 'silent', 'unscorable', 'agreementRate'].sort(),
      );
      expect(body).toEqual({
        results: [],
        agreed: 0,
        disagreed: 0,
        silent: 0,
        unscorable: 0,
        agreementRate: null,
      });
    });

    // Negative control 1: a `rejected` resolution with no winner scores `unscorable`, not
    // `disagreed` — the distinction the client's acceptance criterion turns on.
    it("scores a 'rejected' resolution with no recorded winner as unscorable, not disagreed", async () => {
      const factKey = { entity: 'Fenwick Logistics Center', metric: 'cap_rate', period: '2025-02' };
      const factLow = await seedFact(factKey, { amount: 5.25, unit: 'percent' }, 'chunk-low');
      const factHigh = await seedFact(factKey, { amount: 6.1, unit: 'percent' }, 'chunk-high');
      const conflict = await conflictModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        factIds: [factLow._id, factHigh._id],
        magnitude: 0.0085,
        status: 'open',
        resolution: { outcome: 'rejected', resolvedAt: new Date() },
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts/resolution-backtest')
        .set('Cookie', cookie);
      const body = response.body as ResolutionBacktestBody;

      expect(response.status).toBe(200);
      const result = body.results.find((entry) => entry.conflictId === conflict._id.toString());
      expect(result).toBeDefined();
      expect(result?.verdict).toBe('unscorable');
      expect(result?.recordedOutcome).toBe('rejected');
      expect(result?.unscorableReason).toBe(
        "Outcome 'rejected' recorded no winning fact to score against.",
      );
      expect(Object.keys(result as object).sort()).toEqual(
        ['conflictId', 'factKey', 'verdict', 'recordedOutcome', 'unscorableReason'].sort(),
      );
    });

    // Negative control 2: a resolved conflict whose facts were deleted scores unscorable, and
    // `resolveConflictPolicy` is never called — the spy proves the gate runs BEFORE the policy
    // call, not merely that the label is right. Reachable, not hypothetical:
    // `DocumentsService.remove`'s conflict-shrink update is `status: 'open'`-scoped while its fact
    // `deleteMany` calls are not, so a document deletion can remove facts belonging to an
    // already-`resolved` conflict while its `factIds` still names them.
    it("scores a 'resolved' conflict whose facts no longer resolve as unscorable, and never calls resolveConflictPolicy", async () => {
      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
      const factLow = await seedFact(factKey, { amount: 5.25, unit: 'percent' }, 'chunk-xlsx');
      const factHigh = await seedFact(factKey, { amount: 6.1, unit: 'percent' }, 'chunk-prose');
      const conflict = await conflictModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        factIds: [factLow._id, factHigh._id],
        magnitude: 0.0085,
        status: 'resolved',
        resolution: { outcome: 'resolved', winningFactId: factLow._id, resolvedAt: new Date() },
      });
      await extractedFactModel.deleteMany({ _id: { $in: [factLow._id, factHigh._id] } });

      const policySpy = jest.spyOn(resolveConflictPolicyModule, 'resolveConflictPolicy');

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts/resolution-backtest')
        .set('Cookie', cookie);
      const body = response.body as ResolutionBacktestBody;

      expect(response.status).toBe(200);
      const result = body.results.find((entry) => entry.conflictId === conflict._id.toString());
      expect(result).toBeDefined();
      expect(result?.verdict).toBe('unscorable');
      expect(result?.recordedOutcome).toBe('resolved');
      expect(result?.recordedWinningFactId).toBe(factLow._id.toString());
      expect(result?.unscorableReason).toBe(
        '2 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.',
      );
      expect(policySpy).not.toHaveBeenCalled();
      policySpy.mockRestore();
    });

    it("scores 'agreed' when the replayed rule's authority pick matches the recorded winner, exposing the exact key set of a scored result", async () => {
      const isolatedTenant = await registerTestUser(app, {
        email: 'resolution-backtest-agreed-e2e@example.com',
        password: 'correct-horse-battery',
      });

      const factKey = {
        entity: 'Northgate Business Park',
        metric: 'net_operating_income',
        period: '2025-03',
      };
      const documentPm = await documentModel.create({
        title: 'PM Export',
        sourceKind: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        tenantId: isolatedTenant.tenantId,
        sourceClass: 'pm-export',
      });
      const documentSpreadsheet = await documentModel.create({
        title: 'Comps Spreadsheet',
        sourceKind: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        tenantId: isolatedTenant.tenantId,
        sourceClass: 'spreadsheet',
      });
      const versionPm = await documentVersionModel.create({
        documentId: documentPm._id,
        versionNumber: 1,
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
        storageKey: 'seed-pm-export',
        tenantId: isolatedTenant.tenantId,
      });
      const versionSpreadsheet = await documentVersionModel.create({
        documentId: documentSpreadsheet._id,
        versionNumber: 1,
        sha256: 'b'.repeat(64),
        sizeBytes: 1,
        storageKey: 'seed-spreadsheet',
        tenantId: isolatedTenant.tenantId,
      });
      const factPm = await extractedFactModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId: isolatedTenant.tenantId,
        value: { amount: 500000, unit: 'usd' },
        rawText: 'NOI 500000',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-pm',
        documentVersionId: versionPm._id,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Rent Roll', cell: 'B2' },
      });
      const factSpreadsheet = await extractedFactModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId: isolatedTenant.tenantId,
        value: { amount: 550000, unit: 'usd' },
        rawText: 'NOI 550000',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-comps',
        documentVersionId: versionSpreadsheet._id,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'C4' },
      });
      const conflict = await conflictModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId: isolatedTenant.tenantId,
        factIds: [factPm._id, factSpreadsheet._id],
        magnitude: 50000,
        status: 'resolved',
        resolution: { outcome: 'resolved', winningFactId: factPm._id, resolvedAt: new Date() },
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts/resolution-backtest')
        .set('Cookie', isolatedTenant.cookie);
      const body = response.body as ResolutionBacktestBody;

      expect(response.status).toBe(200);
      expect(body.results).toEqual([
        {
          conflictId: conflict._id.toString(),
          factKey,
          verdict: 'agreed',
          recordedOutcome: 'resolved',
          recordedWinningFactId: factPm._id.toString(),
          replayedRuleFired: 'authority',
          replayedWinningFactId: factPm._id.toString(),
        },
      ]);
      expect(Object.keys(body.results[0]).sort()).toEqual(
        [
          'conflictId',
          'factKey',
          'verdict',
          'recordedOutcome',
          'recordedWinningFactId',
          'replayedRuleFired',
          'replayedWinningFactId',
        ].sort(),
      );
      expect(body).toMatchObject({ agreed: 1, disagreed: 0, silent: 0, unscorable: 0 });
      expect(body.agreementRate).toBe(1);
    });

    it("scores 'silent' when the metric has no configured authorityOrder, excluding it from agreementRate", async () => {
      const isolatedTenant = await registerTestUser(app, {
        email: 'resolution-backtest-silent-e2e@example.com',
        password: 'correct-horse-battery',
      });

      const factKey = { entity: 'Silent Plaza', metric: 'cap_rate', period: '2025-01' };
      const factLow = await seedFact(
        factKey,
        { amount: 5.0, unit: 'percent' },
        'chunk-a',
        isolatedTenant.tenantId,
      );
      const factHigh = await seedFact(
        factKey,
        { amount: 5.6, unit: 'percent' },
        'chunk-b',
        isolatedTenant.tenantId,
      );
      const conflict = await conflictModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId: isolatedTenant.tenantId,
        factIds: [factLow._id, factHigh._id],
        magnitude: 0.006,
        status: 'resolved',
        resolution: { outcome: 'resolved', winningFactId: factLow._id, resolvedAt: new Date() },
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts/resolution-backtest')
        .set('Cookie', isolatedTenant.cookie);
      const body = response.body as ResolutionBacktestBody;

      expect(response.status).toBe(200);
      expect(body.results).toEqual([
        {
          conflictId: conflict._id.toString(),
          factKey,
          verdict: 'silent',
          recordedOutcome: 'resolved',
          recordedWinningFactId: factLow._id.toString(),
          replayedRuleFired: 'none',
        },
      ]);
      expect(body).toEqual({
        results: body.results,
        agreed: 0,
        disagreed: 0,
        silent: 1,
        unscorable: 0,
        agreementRate: null,
      });
    });
  });
});
