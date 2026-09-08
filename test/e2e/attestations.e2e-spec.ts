import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { Answer, AnswerDocument } from '../../src/database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  ConflictDocument,
} from '../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../src/database/schemas/evidence/document-version/document-version.schema';
import {
  Verification,
  VerificationDocument,
} from '../../src/database/schemas/evidence/verification/verification.schema';
import { AttestationService } from '../../src/features/evidence/attestations/attestation.service';
import { groupKey } from '../../src/features/evidence/conflicts/detect-conflicts';
import {
  ACTIVE_PACK_ID,
  ACTIVE_PACK_VERSION,
} from '../../src/features/evidence/facts/metric-ontology';
import type { Citation } from '../../src/features/evidence/qa/contracts/answer.contract';
import { canonicalJson } from '../../src/shared/utils/canonical-json.util';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface AttestationBundleBody {
  schemaVersion: number;
  kind: string;
  subjectId: string;
  tenantId: string;
  producedAt: string;
  subject: unknown;
  outcome: string | null;
  claims: Array<{ statement: string; verdict: string; citations: unknown[] }>;
  decisions: unknown[];
  measures: unknown[];
  integrity: { algorithm: string; contentHash: string };
}

const ATTESTATION_BUNDLE_KEYS = [
  'schemaVersion',
  'kind',
  'subjectId',
  'tenantId',
  'producedAt',
  'subject',
  'outcome',
  'claims',
  'decisions',
  'measures',
  'integrity',
].sort();

describe('Attestations (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let tenantId: string;
  let answerModel: Model<AnswerDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;
  let conflictModel: Model<ConflictDocument>;
  let verificationModel: Model<VerificationDocument>;

  beforeAll(async () => {
    app = await createTestApp();
    ({ cookie, tenantId } = await registerTestUser(app, {
      email: 'attestations-e2e@example.com',
      password: 'correct-horse-battery',
    }));

    answerModel = app.get<Model<AnswerDocument>>(getModelToken(Answer.name));
    documentVersionModel = app.get<Model<DocumentVersionDocument>>(
      getModelToken(DocumentVersion.name),
    );
    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
    verificationModel = app.get<Model<VerificationDocument>>(getModelToken(Verification.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /answers/:id/attestation', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get(
        `/api/v1/answers/${new Types.ObjectId().toString()}/attestation`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 409 for a queued answer', async () => {
      const queued = await answerModel.create({
        tenantId,
        questionText: 'What is the vacancy rate?',
        runStatus: 'queued',
        claims: [],
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/answers/${queued._id.toString()}/attestation`)
        .set('Cookie', cookie);

      expect(response.status).toBe(409);
    });

    it("returns 404 for another tenant's answer and for a malformed id", async () => {
      const otherTenantAnswer = await answerModel.create({
        tenantId: 'attestations-e2e-other-tenant',
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
        claims: [],
      });

      const crossTenantResponse = await request(getTestServer(app))
        .get(`/api/v1/answers/${otherTenantAnswer._id.toString()}/attestation`)
        .set('Cookie', cookie);
      const malformedResponse = await request(getTestServer(app))
        .get('/api/v1/answers/not-an-id/attestation')
        .set('Cookie', cookie);

      expect(crossTenantResponse.status).toBe(404);
      expect(malformedResponse.status).toBe(404);
    });

    it(
      'exports a bundle with the exact key set, a hash the caller can independently recompute, ' +
        'and byte-identical content on a second export; pins attestationHash on the answer row',
      async () => {
        const documentVersion = await documentVersionModel.create({
          tenantId,
          documentId: new Types.ObjectId(),
          versionNumber: 1,
          sha256: 'a'.repeat(64),
          sizeBytes: 100,
          storageKey: 'attestations-e2e-document-version',
        });
        const citation: Citation = {
          docVersionId: documentVersion._id.toString(),
          sha256: 'a'.repeat(64),
          chunkId: 'chunk-1',
          locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
          quote: 'at a cap rate of approximately 6.10%',
        };
        const survivingClaims = [
          { statement: 'The cap rate is approximately 6.10%.', citations: [citation] },
          { statement: 'The vacancy rate is 4%.', citations: [citation] },
        ];
        const factKey = {
          entity: 'Attestations Test Property',
          metric: 'cap_rate',
          period: '2025-Q1',
        };
        const conflict = await conflictModel.create({
          tenantId,
          factKey,
          groupKeyNormalized: groupKey(factKey),
          factIds: [new Types.ObjectId(), new Types.ObjectId()],
          magnitude: 0.0085,
          magnitudeUnit: 'ratio',
          packId: ACTIVE_PACK_ID,
          packVersion: ACTIVE_PACK_VERSION,
          status: 'resolved',
          resolution: {
            outcome: 'resolved',
            winningFactId: new Types.ObjectId(),
            decidedBy: 'reviewer@example.com',
            reason: 'Confirmed via source memo.',
            resolvedAt: new Date('2026-07-02T00:00:00.000Z'),
            ruleFired: 'authority',
            followedProposal: true,
          },
        });

        const answer = await answerModel.create({
          tenantId,
          questionText: 'What is the cap rate and vacancy rate for the property?',
          runStatus: 'completed',
          outcome: { kind: 'answered', claims: survivingClaims },
          claims: survivingClaims,
          claimCoverage: 2 / 3,
          verificationReport: {
            verifiedClaimCount: 2,
            totalClaimCount: 3,
            droppedClaims: [
              { statement: 'The net operating income is $500,000.', reason: 'quote-not-found' },
            ],
          },
          conflictIds: [conflict._id],
        });

        const firstResponse = await request(getTestServer(app))
          .get(`/api/v1/answers/${answer._id.toString()}/attestation`)
          .set('Cookie', cookie);
        const firstBody = firstResponse.body as AttestationBundleBody;

        expect(firstResponse.status).toBe(200);
        expect(Object.keys(firstBody).sort()).toEqual(ATTESTATION_BUNDLE_KEYS);
        expect(firstBody.subjectId).toBe(answer._id.toString());
        expect(firstBody.producedAt).toBe(answer.createdAt.toISOString());
        expect(firstBody.claims).toHaveLength(3);
        expect(firstBody.claims.map((claim) => claim.verdict).sort()).toEqual(
          ['dropped', 'survived', 'survived'].sort(),
        );
        expect(firstBody.decisions).toHaveLength(1);

        const recomputedHash = createHash('sha256')
          .update(canonicalJson({ ...firstBody, integrity: undefined }), 'utf8')
          .digest('hex');
        expect(firstBody.integrity.contentHash).toBe(recomputedHash);

        const secondResponse = await request(getTestServer(app))
          .get(`/api/v1/answers/${answer._id.toString()}/attestation`)
          .set('Cookie', cookie);

        expect(secondResponse.status).toBe(200);
        expect(JSON.stringify(secondResponse.body)).toBe(JSON.stringify(firstBody));

        const serviceBundle = await app
          .get(AttestationService)
          .exportForAnswer(answer._id.toString(), tenantId);
        expect(canonicalJson(firstBody)).toBe(canonicalJson(serviceBundle));

        const answerAfterExport = await request(getTestServer(app))
          .get(`/api/v1/answers/${answer._id.toString()}`)
          .set('Cookie', cookie);
        expect((answerAfterExport.body as { attestationHash?: string }).attestationHash).toBe(
          firstBody.integrity.contentHash,
        );
      },
    );
  });

  describe('GET /verifications/:id/attestation', () => {
    it("returns 404 for another tenant's verification", async () => {
      const otherTenantVerification = await verificationModel.create({
        tenantId: 'attestations-e2e-other-tenant',
        requestedBy: { kind: 'user', id: 'someone-else' },
        claims: ['The cap rate is 6.1%.'],
        results: [{ claimIndex: 0, verdict: 'grounded' }],
        advisory: 'advisory text',
        retrievedChunkIds: [],
        atoms: [],
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.0001 },
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/verifications/${otherTenantVerification._id.toString()}/attestation`)
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it(
      'exports a bundle with no key on the verification row before the first export, then pins ' +
        'attestationHash equal to integrity.contentHash after it',
      async () => {
        const verification = await verificationModel.create({
          tenantId,
          requestedBy: { kind: 'user', id: 'attestations-e2e-user' },
          claims: ['The cap rate is 6.1%.'],
          results: [{ claimIndex: 0, verdict: 'grounded' }],
          advisory: 'advisory text',
          retrievedChunkIds: [],
          atoms: [],
          usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.0001 },
        });

        const beforeExport = await request(getTestServer(app))
          .get(`/api/v1/verifications/${verification._id.toString()}`)
          .set('Cookie', cookie);
        expect(Object.keys(beforeExport.body as object)).not.toContain('attestationHash');

        const attestationResponse = await request(getTestServer(app))
          .get(`/api/v1/verifications/${verification._id.toString()}/attestation`)
          .set('Cookie', cookie);
        const attestationBody = attestationResponse.body as AttestationBundleBody;

        expect(attestationResponse.status).toBe(200);
        expect(Object.keys(attestationBody).sort()).toEqual(ATTESTATION_BUNDLE_KEYS);
        expect(attestationBody.kind).toBe('verification');
        expect(attestationBody.decisions).toEqual([]);

        const afterExport = await request(getTestServer(app))
          .get(`/api/v1/verifications/${verification._id.toString()}`)
          .set('Cookie', cookie);
        expect((afterExport.body as { attestationHash?: string }).attestationHash).toBe(
          attestationBody.integrity.contentHash,
        );
      },
    );
  });
});
