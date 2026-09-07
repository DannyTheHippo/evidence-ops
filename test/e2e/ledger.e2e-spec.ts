import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import {
  Conflict,
  type ConflictDocument,
} from '../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  type DocumentDocument,
} from '../../src/database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  type DocumentVersionDocument,
} from '../../src/database/schemas/evidence/document-version/document-version.schema';
import {
  ExtractedFact,
  type ExtractedFactDocument,
} from '../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { groupKey } from '../../src/features/evidence/conflicts/detect-conflicts';
import { UNDATED_PERIOD } from '../../src/features/evidence/facts/derive-period';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { measureStamp, type MeasureStamp } from '../utils/measure-stamp';
import { registerTestUser } from '../utils/register-test-user';

// Every fixture here extracts against the 'cre' v1 pack, the only ontology this code has had —
// the pack stamp stays on facts as seed provenance beside the per-measure stamp.
const PACK_STAMP = { packId: 'cre', packVersion: 1 } as const;

interface LedgerCellBody {
  entity: string;
  measure: string;
  period: string;
  state: string;
  value?: { amount: number; unit: string; canonicalAmount?: number };
  factIds: string[];
  conflictId?: string;
  decision?: Record<string, unknown>;
  winnerWithdrawn?: boolean;
}

interface LedgerResolutionBody extends LedgerCellBody {
  citations: Record<string, unknown>[];
}

interface LedgerFactBody {
  id: string;
  measureStatus: string;
  value: { amount: number; unit: string };
}

interface LedgerEntityBody {
  entity: string;
  factCount: number;
  measureCount: number;
}

// A cell carrying one agreed value: the optional conflict fields are absent rather than null,
// because class-transformer drops an undefined @Expose()d field during JSON serialization.
const SINGLE_CELL_KEYS = ['entity', 'measure', 'period', 'state', 'value', 'factIds'].sort();

// No top-level `conflictId`: that field marks a cell with an OPEN conflict — something still to
// decide. Once decided, the conflict is named inside `decision` instead, so a caller reading
// `conflictId` is reading a work queue rather than a history.
const ADJUDICATED_CELL_KEYS = [
  'entity',
  'measure',
  'period',
  'state',
  'value',
  'factIds',
  'decision',
  'winnerWithdrawn',
].sort();

const DECISION_KEYS = [
  'conflictId',
  'outcome',
  'winningFactId',
  'decidedBy',
  'reason',
  'resolvedAt',
  'ruleFired',
  'followedProposal',
].sort();

const CITATION_KEYS = [
  'factId',
  'documentId',
  'documentVersionId',
  'sha256',
  'locator',
  'extractorVersion',
  'quote',
  'withdrawn',
].sort();

const LEDGER_ENTITY_KEYS = ['entity', 'factCount', 'measureCount'].sort();

const SINGLE_ENTITY = 'Ledger Single Tower';
const CONFLICT_ENTITY = 'Ledger Conflict Yard';
const ADJUDICATED_ENTITY = 'Ledger Adjudicated Plaza';
const PROPOSED_ENTITY = 'Ledger Proposed Annex';

describe('Ledger (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let tenantId: string;
  let documentModel: Model<DocumentDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;
  let conflictModel: Model<ConflictDocument>;

  const measureStampCache = new Map<string, MeasureStamp>();
  const getMeasureStamp = async (slug: string): Promise<MeasureStamp> => {
    const cached = measureStampCache.get(slug);
    if (cached) {
      return cached;
    }
    const stamp = await measureStamp(app, tenantId, slug);
    measureStampCache.set(slug, stamp);
    return stamp;
  };

  /** One stored document version, so a fact minted against it produces a checkable citation. */
  const seedVersion = async (
    sha256: string,
    storageKey: string,
    withdrawn = false,
  ): Promise<DocumentVersionDocument> => {
    const document = await documentModel.create({
      tenantId,
      title: `${storageKey}.xlsx`,
      sourceKind: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sourceClass: 'unclassified',
    });

    return documentVersionModel.create({
      tenantId,
      documentId: document._id,
      versionNumber: 1,
      sha256,
      sizeBytes: 100,
      storageKey,
      ...(withdrawn ? { withdrawnAt: new Date(), withdrawnReason: 'source-file-absent' } : {}),
    });
  };

  const seedFact = async (
    entity: string,
    metric: string,
    amount: number,
    unit: string,
    version: DocumentVersionDocument,
    overrides: Record<string, unknown> = {},
  ): Promise<ExtractedFactDocument> => {
    const factKey = { entity, metric, period: UNDATED_PERIOD };

    return extractedFactModel.create({
      tenantId,
      factKey,
      groupKeyNormalized: groupKey(factKey),
      value: { amount, unit },
      rawText: `${amount}${unit === 'percent' ? '%' : ''}`,
      confidence: 0.9,
      extractionMethod: 'llm',
      ...PACK_STAMP,
      ...(await getMeasureStamp(metric)),
      chunkId: `chunk-${entity}-${metric}-${amount}`,
      documentVersionId: version._id,
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      ...overrides,
    });
  };

  beforeAll(async () => {
    app = await createTestApp();

    ({ cookie, tenantId } = await registerTestUser(app, {
      email: 'ledger-e2e@example.com',
      password: 'correct-horse-battery',
    }));

    documentModel = app.get<Model<DocumentDocument>>(getModelToken(Document.name));
    documentVersionModel = app.get<Model<DocumentVersionDocument>>(
      getModelToken(DocumentVersion.name),
    );
    extractedFactModel = app.get<Model<ExtractedFactDocument>>(getModelToken(ExtractedFact.name));
    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));

    // `single`: one confirmed fact, nothing to disagree with.
    const singleVersion = await seedVersion('a'.repeat(64), 'ledger-single');
    await seedFact(SINGLE_ENTITY, 'cap_rate', 5.25, 'percent', singleVersion);

    // `conflicted`: two facts beyond tolerance, with the open conflict row recorded.
    const conflictLowVersion = await seedVersion('b'.repeat(64), 'ledger-conflict-low');
    const conflictHighVersion = await seedVersion('c'.repeat(64), 'ledger-conflict-high');
    const low = await seedFact(CONFLICT_ENTITY, 'cap_rate', 5.25, 'percent', conflictLowVersion);
    const high = await seedFact(CONFLICT_ENTITY, 'cap_rate', 6.1, 'percent', conflictHighVersion);
    const conflictFactKey = {
      entity: CONFLICT_ENTITY,
      metric: 'cap_rate',
      period: UNDATED_PERIOD,
    };
    await conflictModel.create({
      tenantId,
      factKey: conflictFactKey,
      groupKeyNormalized: groupKey(conflictFactKey),
      factIds: [low._id, high._id],
      magnitude: 0.0085,
      magnitudeUnit: 'ratio',
      ...PACK_STAMP,
      status: 'open',
    });

    // `adjudicated`: the winner sits on a version withdrawn after the decision was taken, so the
    // decision must survive the withdrawal and say so.
    const winnerVersion = await seedVersion('d'.repeat(64), 'ledger-winner', true);
    const loserVersion = await seedVersion('e'.repeat(64), 'ledger-loser');
    const winner = await seedFact(
      ADJUDICATED_ENTITY,
      'net_operating_income',
      2134450,
      'usd',
      winnerVersion,
    );
    const loser = await seedFact(
      ADJUDICATED_ENTITY,
      'net_operating_income',
      1980000,
      'usd',
      loserVersion,
    );
    const adjudicatedFactKey = {
      entity: ADJUDICATED_ENTITY,
      metric: 'net_operating_income',
      period: UNDATED_PERIOD,
    };
    await conflictModel.create({
      tenantId,
      factKey: adjudicatedFactKey,
      groupKeyNormalized: groupKey(adjudicatedFactKey),
      factIds: [winner._id, loser._id],
      magnitude: 154450,
      magnitudeUnit: 'usd',
      ...PACK_STAMP,
      status: 'resolved',
      resolution: {
        outcome: 'resolved',
        winningFactId: winner._id,
        decidedBy: new Types.ObjectId().toString(),
        reason: 'The audited statement supersedes the broker summary.',
        resolvedAt: new Date(),
        ruleFired: 'authority',
        followedProposal: true,
      },
    });

    // A fact stamped under a measure the tenant has not confirmed: stored, but excluded from every
    // ledger answer until an admin confirms it.
    const proposedVersion = await seedVersion('f'.repeat(64), 'ledger-proposed');
    await seedFact(PROPOSED_ENTITY, 'cap_rate', 7.4, 'percent', proposedVersion, {
      measureStatus: 'proposed',
    });
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /ledger', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/ledger');

      expect(response.status).toBe(401);
    });

    it('rejects an unknown query field rather than ignoring it', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger?entty=Northgate')
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('resolves a lone confirmed fact to a single cell, exposing the exact key set', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger')
        .set('Cookie', cookie);
      const body = response.body as { docs: LedgerCellBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['count', 'docs']);
      const row = body.docs.find((doc) => doc.entity === SINGLE_ENTITY);
      expect(row).toBeDefined();
      expect(row?.state).toBe('single');
      expect(row?.measure).toBe('cap_rate');
      expect(row?.period).toBe(UNDATED_PERIOD);
      expect(row?.value).toEqual({ amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 });
      expect(row?.factIds).toHaveLength(1);
      // The only gate that catches a response-DTO field missing @Expose(): such a field is
      // dropped from the payload with no error and a 200 status.
      expect(Object.keys(row!).sort()).toEqual(SINGLE_CELL_KEYS);
    });

    it('reports two disagreeing facts as conflicted, naming the recorded conflict', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger')
        .set('Cookie', cookie);
      const body = response.body as { docs: LedgerCellBody[]; count: number };
      const row = body.docs.find((doc) => doc.entity === CONFLICT_ENTITY);

      expect(row).toBeDefined();
      expect(row?.state).toBe('conflicted');
      expect(row?.conflictId).toBeDefined();
      expect(row?.factIds).toHaveLength(2);
      // A conflicted cell carries no value: the record does not pick a side the sources have not.
      expect(row?.value).toBeUndefined();
    });

    it('keeps an adjudicated decision standing when its winning version is withdrawn', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger')
        .set('Cookie', cookie);
      const body = response.body as { docs: LedgerCellBody[]; count: number };
      const row = body.docs.find((doc) => doc.entity === ADJUDICATED_ENTITY);

      expect(row).toBeDefined();
      expect(row?.state).toBe('adjudicated');
      expect(row?.value).toEqual({
        amount: 2134450,
        unit: 'usd',
        canonicalAmount: 2134450,
      });
      // The document behind the decision was withdrawn; the human decision is still the record.
      expect(row?.winnerWithdrawn).toBe(true);
      expect(Object.keys(row!).sort()).toEqual(ADJUDICATED_CELL_KEYS);
      expect(row?.conflictId).toBeUndefined();
      expect(Object.keys(row!.decision!).sort()).toEqual(DECISION_KEYS);
      expect(row?.decision?.conflictId).toBeDefined();
      expect(row?.decision?.outcome).toBe('resolved');
      expect(row?.decision?.reason).toBe('The audited statement supersedes the broker summary.');
    });

    it('excludes a fact stamped under an unconfirmed measure', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger')
        .set('Cookie', cookie);
      const body = response.body as { docs: LedgerCellBody[]; count: number };

      expect(body.docs.find((doc) => doc.entity === PROPOSED_ENTITY)).toBeUndefined();
    });

    it('filters by resolved state', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger?state=conflicted')
        .set('Cookie', cookie);
      const body = response.body as { docs: LedgerCellBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs.length).toBeGreaterThan(0);
      expect(body.docs.every((doc) => doc.state === 'conflicted')).toBe(true);
      expect(body.docs.some((doc) => doc.entity === CONFLICT_ENTITY)).toBe(true);
    });

    it('filters by measure slug', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger?measure=net_operating_income')
        .set('Cookie', cookie);
      const body = response.body as { docs: LedgerCellBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs.every((doc) => doc.measure === 'net_operating_income')).toBe(true);
    });
  });

  describe('GET /ledger/resolve', () => {
    it('returns citations whose sha256 pins the version the quote was read from', async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/ledger/resolve?entity=${encodeURIComponent(SINGLE_ENTITY)}&measure=cap_rate`)
        .set('Cookie', cookie);
      const body = response.body as LedgerResolutionBody;

      expect(response.status).toBe(200);
      expect(body.state).toBe('single');
      expect(body.citations).toHaveLength(1);
      expect(Object.keys(body.citations[0]).sort()).toEqual(CITATION_KEYS);
      expect(body.citations[0].sha256).toBe('a'.repeat(64));
      expect(body.citations[0].quote).toBe('5.25%');
      expect(body.citations[0].withdrawn).toBe(false);
    });

    it('resolves an entity through a registered alias to its canonical cell', async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/ledger/resolve?entity=${encodeURIComponent(SINGLE_ENTITY)}&measure=cap_rate`)
        .set('Cookie', cookie);
      const body = response.body as LedgerResolutionBody;

      expect(body.entity).toBe(SINGLE_ENTITY);
      expect(body.measure).toBe('cap_rate');
      expect(body.period).toBe(UNDATED_PERIOD);
    });

    it('answers unknown for an entity the ledger holds no facts for', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger/resolve?entity=Nowhere%20Holdings&measure=cap_rate')
        .set('Cookie', cookie);
      const body = response.body as LedgerResolutionBody;

      expect(response.status).toBe(200);
      expect(body.state).toBe('unknown');
      expect(body.factIds).toEqual([]);
      expect(body.citations).toEqual([]);
    });

    it('returns 404 for a measure the tenant does not hold', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger/resolve?entity=Anything&measure=not_a_measure')
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('rejects a request missing the required measure', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger/resolve?entity=Anything')
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });
  });

  describe('GET /ledger/facts', () => {
    it('lists the facts behind a cell', async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/ledger/facts?entity=${encodeURIComponent(CONFLICT_ENTITY)}&measure=cap_rate`)
        .set('Cookie', cookie);
      const body = response.body as { docs: LedgerFactBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(2);
      expect(body.docs.map((doc) => doc.value.amount).sort()).toEqual([5.25, 6.1]);
      expect(body.docs.every((doc) => doc.measureStatus === 'confirmed')).toBe(true);
    });

    it('shows the proposed-measure fact the cell view hides, labelled by its status', async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/ledger/facts?entity=${encodeURIComponent(PROPOSED_ENTITY)}&measure=cap_rate`)
        .set('Cookie', cookie);
      const body = response.body as { docs: LedgerFactBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      // The asymmetry is the point: the drill-down is where an operator sees what the answer
      // deliberately excluded, rather than the row simply vanishing.
      expect(body.docs[0].measureStatus).toBe('proposed');
      expect(body.docs[0].value.amount).toBe(7.4);
    });
  });

  describe('GET /ledger/entities', () => {
    it('lists entities with their confirmed fact and measure counts', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/ledger/entities')
        .set('Cookie', cookie);
      const body = response.body as { docs: LedgerEntityBody[]; count: number };

      expect(response.status).toBe(200);
      const row = body.docs.find((doc) => doc.entity === ADJUDICATED_ENTITY);
      expect(row).toBeDefined();
      expect(Object.keys(row!).sort()).toEqual(LEDGER_ENTITY_KEYS);
      expect(row?.factCount).toBe(2);
      expect(row?.measureCount).toBe(1);
      // The proposed-measure fact is excluded here too — the roster counts the record, not drafts.
      expect(body.docs.find((doc) => doc.entity === PROPOSED_ENTITY)).toBeUndefined();
    });
  });
});
