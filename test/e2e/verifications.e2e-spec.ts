import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import {
  AuditEvent,
  AuditEventDocument,
} from '../../src/database/schemas/audit/audit-event/audit-event.schema';
import {
  Verification,
  VerificationDocument,
} from '../../src/database/schemas/evidence/verification/verification.schema';
import type { Citation } from '../../src/features/evidence/qa/contracts/answer.contract';
import type { VerifyClaimResult } from '../../src/features/evidence/qa/contracts/verify-claims.contract';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface VerificationRequesterBody {
  kind: string;
  id: string;
}

interface VerifyClaimResultBody {
  claimIndex: number;
  verdict: string;
  reasonCode?: string;
  citations?: unknown[];
}

interface VerificationBody {
  id: string;
  requestedBy: VerificationRequesterBody;
  claims: string[];
  results: VerifyClaimResultBody[];
  advisory: string;
  retrievedChunkIds: string[];
  atoms: unknown[];
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
  createdAt: string;
  attestationHash?: string;
}

describe('Verifications (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let userId: string;
  let tenantId: string;
  let verificationModel: Model<VerificationDocument>;
  let auditEventModel: Model<AuditEventDocument>;

  let patVerification: VerificationDocument;
  let userVerification: VerificationDocument;
  let otherTenantVerification: VerificationDocument;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = {
      email: 'verifications-e2e@example.com',
      password: 'correct-horse-battery',
    };
    ({ cookie, userId, tenantId } = await registerTestUser(app, credentials));

    verificationModel = app.get<Model<VerificationDocument>>(getModelToken(Verification.name));
    auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));

    const citation: Citation = {
      docVersionId: 'version-1',
      sha256: 'a'.repeat(64),
      chunkId: 'chunk-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
      quote: 'at a cap rate of approximately 6.10%',
    };
    const claims = [
      'The cap rate is 6.1%.',
      'The vacancy rate is 4%.',
      'The net operating income is $500,000.',
    ];
    const results: VerifyClaimResult[] = [
      { claimIndex: 0, verdict: 'grounded', citations: [citation] },
      { claimIndex: 1, verdict: 'not_grounded', reasonCode: 'claim-contradicted' },
      { claimIndex: 2, verdict: 'no_evidence_retrieved' },
    ];
    const advisory =
      'A "grounded" verdict means an independent verifier located supporting evidence for this claim.';
    const usage = { promptTokens: 640, completionTokens: 120, costUsd: 0.0031 };

    patVerification = await verificationModel.create({
      tenantId,
      requestedBy: { kind: 'pat', id: userId },
      claims,
      results,
      advisory,
      retrievedChunkIds: ['chunk-1'],
      atoms: [{ claimIndex: 0, statement: claims[0], atoms: [claims[0]] }],
      usage,
    });
    userVerification = await verificationModel.create({
      tenantId,
      requestedBy: { kind: 'user', id: userId },
      claims,
      results,
      advisory,
      retrievedChunkIds: ['chunk-1'],
      atoms: [{ claimIndex: 0, statement: claims[0], atoms: [claims[0]] }],
      usage,
      attestationHash: 'c'.repeat(64),
    });
    otherTenantVerification = await verificationModel.create({
      tenantId: 'verifications-e2e-other-tenant',
      requestedBy: { kind: 'pat', id: 'other-tenant-caller' },
      claims,
      results,
      advisory,
      retrievedChunkIds: ['chunk-1'],
      atoms: [],
      usage,
    });

    // Stamped explicitly, out of creation order — sequential in-memory creates can land in the
    // same millisecond, which would make the newest-first assertion below flaky.
    await verificationModel.updateOne(
      { _id: patVerification._id },
      { createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { overwriteImmutable: true },
    );
    await verificationModel.updateOne(
      { _id: userVerification._id },
      { createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { overwriteImmutable: true },
    );

    // Proves the fixture itself, not just the ordering it produces — an update that silently
    // strips `createdAt` would leave every row at its real insertion time, and the assertions
    // below could still pass by coincidence.
    const backdatedPat = await verificationModel.findById(patVerification._id);
    expect(backdatedPat?.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const backdatedUser = await verificationModel.findById(userVerification._id);
    expect(backdatedUser?.createdAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /verifications', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/verifications');

      expect(response.status).toBe(401);
    });

    it('lists the tenant verification runs newest first, excluding a different tenant row', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/verifications')
        .set('Cookie', cookie);
      const body = response.body as { docs: VerificationBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(2);
      expect(body.docs.map((doc) => doc.id)).toEqual([
        userVerification._id.toString(),
        patVerification._id.toString(),
      ]);
      expect(body.docs.map((doc) => doc.id)).not.toContain(otherTenantVerification._id.toString());
    });

    it('filters by requestedByKind', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/verifications')
        .query({ requestedByKind: 'pat' })
        .set('Cookie', cookie);
      const body = response.body as { docs: VerificationBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0].id).toBe(patVerification._id.toString());
    });

    it('paginates with limit and skip, count reflecting the total, not the page', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/verifications')
        .query({ limit: 1, skip: 1 })
        .set('Cookie', cookie);
      const body = response.body as { docs: VerificationBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs).toHaveLength(1);
      expect(body.count).toBe(2);
    });

    it('returns 400 for a sort field outside the declared allowlist', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/verifications')
        .query({ sort: 'usage' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });
  });

  describe('GET /verifications/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get(
        `/api/v1/verifications/${patVerification._id.toString()}`,
      );

      expect(response.status).toBe(401);
    });

    it('gets one verification run, exposing the exact key sets and the resolved reasonCode, and records an audit event', async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/verifications/${patVerification._id.toString()}`)
        .set('Cookie', cookie);
      const body = response.body as VerificationBody;

      expect(response.status).toBe(200);
      // Exact-key assertion: the only gate catching a VerificationResponseDto field missing
      // @Expose().
      expect(Object.keys(body).sort()).toEqual(
        [
          'id',
          'requestedBy',
          'claims',
          'results',
          'advisory',
          'retrievedChunkIds',
          'atoms',
          'usage',
          'createdAt',
        ].sort(),
      );
      expect(Object.keys(body.requestedBy).sort()).toEqual(['kind', 'id'].sort());
      expect(body.results[1].reasonCode).toBe('claim-contradicted');

      const events = await auditEventModel.find({
        action: 'verifications.verification.viewed',
        'subject.entityId': new Types.ObjectId(patVerification._id.toString()),
      });
      expect(events).toHaveLength(1);
    });

    it('exposes attestationHash when set and withholds it when absent', async () => {
      const withHash = await request(getTestServer(app))
        .get(`/api/v1/verifications/${userVerification._id.toString()}`)
        .set('Cookie', cookie);
      const withoutHash = await request(getTestServer(app))
        .get(`/api/v1/verifications/${patVerification._id.toString()}`)
        .set('Cookie', cookie);

      expect((withHash.body as VerificationBody).attestationHash).toBe('c'.repeat(64));
      expect(Object.keys(withoutHash.body as VerificationBody)).not.toContain('attestationHash');
    });

    // Cross-tenant isolation: a 403 would confirm the row exists in someone else's tenant, so a
    // cross-tenant read must be indistinguishable from an id that never resolves at all.
    it('returns 404, never 403, for a verification belonging to a different tenant', async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/verifications/${otherTenantVerification._id.toString()}`)
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('returns 404 for a malformed id', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/verifications/not-an-id')
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });
  });
});
