import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import {
  Invitation,
  InvitationDocument,
} from '../../src/database/schemas/administration/invitation/invitation.schema';
import { InvitationsService } from '../../src/features/common/invitations/invitations.service';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface MintedInvitationBody {
  id: string;
  email: string;
  role: UserRole;
  token: string;
  expiresAt: string;
  createdAt: string;
}

interface InvitationBody {
  id: string;
  email: string;
  role: UserRole;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  createdAt: string;
}

const MINTED_INVITATION_KEYS = ['id', 'email', 'role', 'token', 'expiresAt', 'createdAt'].sort();
const LIST_INVITATION_KEYS = ['id', 'email', 'role', 'expiresAt', 'createdAt'].sort();

describe('Invitations (e2e)', () => {
  let app: INestApplication;
  let adminCookie: string;
  let memberCookie: string;
  let tenantId: string;
  let invitationModel: Model<InvitationDocument>;
  let invitationsService: InvitationsService;

  beforeAll(async () => {
    app = await createTestApp();

    invitationModel = app.get<Model<InvitationDocument>>(getModelToken(Invitation.name));
    invitationsService = app.get<InvitationsService>(InvitationsService);

    const admin = await registerTestUser(app, {
      email: 'invitations-admin-e2e@example.com',
      password: 'correct-horse-battery',
    });
    adminCookie = admin.cookie;
    tenantId = admin.tenantId;

    const member = await registerTestUser(
      app,
      { email: 'invitations-member-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    memberCookie = member.cookie;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('POST /invitations', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .send({ email: 'colleague-unauth@example.com', role: UserRole.Member });

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', memberCookie)
        .send({ email: 'colleague-member-attempt@example.com', role: UserRole.Member });

      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        expect.objectContaining({
          statusCode: 403,
          message: 'Insufficient role for this action',
          error: 'Forbidden',
        }),
      );
    });

    it('mints an invitation, exposing the exact key set including the plaintext token exactly once', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'colleague-mint@example.com', role: UserRole.Member });
      const body = response.body as MintedInvitationBody;

      expect(response.status).toBe(201);
      expect(body.email).toBe('colleague-mint@example.com');
      expect(body.role).toBe(UserRole.Member);
      expect(body.token.startsWith('eo_inv_')).toBe(true);
      expect(Object.keys(body).sort()).toEqual(MINTED_INVITATION_KEYS);

      const stored = await invitationModel.findById(body.id);
      expect(stored?.tokenHash).not.toBe(body.token);
      expect(stored).not.toHaveProperty('token');
    });

    it('lowercases the invited email', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'Mixed-Case@Example.com', role: UserRole.Admin });
      const body = response.body as MintedInvitationBody;

      expect(response.status).toBe(201);
      expect(body.email).toBe('mixed-case@example.com');
    });

    it('refuses inviting an email that already has an account', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'invitations-member-e2e@example.com', role: UserRole.Member });

      expect(response.status).toBe(409);
    });
  });

  describe('GET /invitations', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/invitations');

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/invitations')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    /**
     * The property `tokenHash` at rest exists to guarantee: mint an invitation, then read it back
     * through every read path the feature exposes — the list endpoint's HTTP response, and the raw
     * persisted document — and the plaintext token appears in neither, only in the one-time mint
     * response captured above.
     */
    it('lists an invitation with metadata only, exact key set, the raw token absent from every subsequent read', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'colleague-listed@example.com', role: UserRole.Member });
      const mintedBody = minted.body as MintedInvitationBody;

      const response = await request(getTestServer(app))
        .get('/api/v1/invitations')
        .set('Cookie', adminCookie);
      const body = response.body as { docs: InvitationBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      const listedInvitation = body.docs.find((doc) => doc.id === mintedBody.id);
      expect(listedInvitation).toBeDefined();
      expect(listedInvitation).not.toHaveProperty('token');
      expect(listedInvitation).not.toHaveProperty('tokenHash');
      // Absent, not null, while the invitation is still pending — see the revoked counterpart
      // below for the same field once it is populated.
      expect(listedInvitation).not.toHaveProperty('revokedAt');
      expect(JSON.stringify(listedInvitation)).not.toContain(mintedBody.token);
      expect(Object.keys(listedInvitation as InvitationBody).sort()).toEqual(LIST_INVITATION_KEYS);

      const stored = await invitationModel.findById(mintedBody.id);
      expect(JSON.stringify(stored?.toJSON())).not.toContain(mintedBody.token);
    });

    it('keeps a revoked invitation listed and exposes revokedAt, rather than hiding it', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'colleague-listed-revoked@example.com', role: UserRole.Member });
      const mintedBody = minted.body as MintedInvitationBody;

      const revokeResponse = await request(getTestServer(app))
        .delete(`/api/v1/invitations/${mintedBody.id}`)
        .set('Cookie', adminCookie);
      expect(revokeResponse.status).toBe(204);

      const response = await request(getTestServer(app))
        .get('/api/v1/invitations')
        .set('Cookie', adminCookie);
      const body = response.body as { docs: InvitationBody[]; count: number };

      const listedInvitation = body.docs.find((doc) => doc.id === mintedBody.id);
      expect(listedInvitation).toBeDefined();
      expect(typeof listedInvitation?.revokedAt).toBe('string');
      expect(new Date(listedInvitation?.revokedAt as string).getTime()).not.toBeNaN();
    });

    it('excludes a row belonging to a different tenant', async () => {
      const other = await registerTestUser(app, {
        email: 'invitations-other-tenant-e2e@example.com',
        password: 'correct-horse-battery',
      });
      await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', other.cookie)
        .send({ email: 'colleague-other-tenant@example.com', role: UserRole.Member });

      const response = await request(getTestServer(app))
        .get('/api/v1/invitations')
        .set('Cookie', adminCookie);
      const body = response.body as { docs: InvitationBody[]; count: number };

      expect(
        body.docs.find((doc) => doc.email === 'colleague-other-tenant@example.com'),
      ).toBeUndefined();
    });

    it('paginates with skip and limit', async () => {
      const paged = await registerTestUser(app, {
        email: 'invitations-paged-e2e@example.com',
        password: 'correct-horse-battery',
      });
      for (let i = 0; i < 3; i += 1) {
        await request(getTestServer(app))
          .post('/api/v1/invitations')
          .set('Cookie', paged.cookie)
          .send({ email: `colleague-paged-${i}@example.com`, role: UserRole.Member });
      }

      const firstPage = await request(getTestServer(app))
        .get('/api/v1/invitations?skip=0&limit=2')
        .set('Cookie', paged.cookie);
      const firstBody = firstPage.body as { docs: InvitationBody[]; count: number };

      const secondPage = await request(getTestServer(app))
        .get('/api/v1/invitations?skip=2&limit=2')
        .set('Cookie', paged.cookie);
      const secondBody = secondPage.body as { docs: InvitationBody[]; count: number };

      expect(firstBody.docs).toHaveLength(2);
      expect(firstBody.count).toBe(3);
      expect(secondBody.docs).toHaveLength(1);
      expect(secondBody.count).toBe(3);
    });
  });

  /**
   * `verify` has no HTTP route of its own — `POST /api/v1/auth/register` is the only caller, and
   * the redemption flow it drives (join the inviting tenant, refuse a stale token, refuse an
   * already-registered invitation email) is covered in `auth.e2e-spec.ts`. Exercised directly here
   * through the service, mirroring how `api-keys.e2e-spec.ts` exercises `TOKEN_VERIFIER`.
   */
  describe('InvitationsService.verify', () => {
    it('verifies a freshly minted, unredeemed token to the invitation’s tenant, email and role', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'colleague-verify@example.com', role: UserRole.Member });
      const mintedBody = minted.body as MintedInvitationBody;

      const identity = await invitationsService.verify(mintedBody.token);

      expect(identity).toEqual({
        id: mintedBody.id,
        tenantId,
        email: 'colleague-verify@example.com',
        role: UserRole.Member,
      });
    });

    it('refuses an already-redeemed token', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'colleague-verify-redeemed@example.com', role: UserRole.Member });
      const mintedBody = minted.body as MintedInvitationBody;
      await invitationModel.updateOne({ _id: mintedBody.id }, { acceptedAt: new Date() });

      const identity = await invitationsService.verify(mintedBody.token);

      expect(identity).toBeNull();
    });

    it('refuses an unrecognized token', async () => {
      const identity = await invitationsService.verify('eo_inv_never-minted-fixture');

      expect(identity).toBeNull();
    });

    it('refuses a revoked token', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'colleague-verify-revoked@example.com', role: UserRole.Member });
      const mintedBody = minted.body as MintedInvitationBody;
      await invitationModel.updateOne({ _id: mintedBody.id }, { revokedAt: new Date() });

      const identity = await invitationsService.verify(mintedBody.token);

      expect(identity).toBeNull();
    });
  });

  describe('DELETE /invitations/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).delete(
        '/api/v1/invitations/65f1c2e4a1b2c3d4e5f6a7b8',
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/invitations/65f1c2e4a1b2c3d4e5f6a7b8')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    it('returns 404 for an unknown invitation id', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/invitations/65f1c2e4a1b2c3d4e5f6a7b8')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
    });

    it('returns 404 for a different tenant’s invitation', async () => {
      const other = await registerTestUser(app, {
        email: 'invitations-revoke-other-tenant-e2e@example.com',
        password: 'correct-horse-battery',
      });
      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', other.cookie)
        .send({ email: 'colleague-revoke-other-tenant@example.com', role: UserRole.Member });
      const mintedBody = minted.body as MintedInvitationBody;

      const response = await request(getTestServer(app))
        .delete(`/api/v1/invitations/${mintedBody.id}`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
    });

    it('revokes an outstanding invitation, refusing both verify and accept afterwards', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'colleague-revoke@example.com', role: UserRole.Member });
      const mintedBody = minted.body as MintedInvitationBody;

      const revokeResponse = await request(getTestServer(app))
        .delete(`/api/v1/invitations/${mintedBody.id}`)
        .set('Cookie', adminCookie);

      expect(revokeResponse.status).toBe(204);

      const identity = await invitationsService.verify(mintedBody.token);
      expect(identity).toBeNull();

      const registerResponse = await request(getTestServer(app))
        .post('/api/v1/auth/register')
        .send({ password: 'correct-horse-battery', invitationToken: mintedBody.token });

      expect(registerResponse.status).toBe(400);
    });
  });

  describe('POST /invitations/:id/resend', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).post(
        '/api/v1/invitations/65f1c2e4a1b2c3d4e5f6a7b8/resend',
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/invitations/65f1c2e4a1b2c3d4e5f6a7b8/resend')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    it('returns 404 for an unknown invitation id', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/invitations/65f1c2e4a1b2c3d4e5f6a7b8/resend')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
    });

    it('returns 404 for a revoked invitation, refusing to resurrect it', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'colleague-resend-revoked@example.com', role: UserRole.Member });
      const mintedBody = minted.body as MintedInvitationBody;
      await invitationModel.updateOne({ _id: mintedBody.id }, { revokedAt: new Date() });

      const response = await request(getTestServer(app))
        .post(`/api/v1/invitations/${mintedBody.id}/resend`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
    });

    it('rotates the token, exposing the same key set as mint, and invalidates the previous link', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', adminCookie)
        .send({ email: 'colleague-resend@example.com', role: UserRole.Member });
      const mintedBody = minted.body as MintedInvitationBody;

      const resendResponse = await request(getTestServer(app))
        .post(`/api/v1/invitations/${mintedBody.id}/resend`)
        .set('Cookie', adminCookie);
      const resentBody = resendResponse.body as MintedInvitationBody;

      expect(resendResponse.status).toBe(201);
      expect(Object.keys(resentBody).sort()).toEqual(MINTED_INVITATION_KEYS);
      expect(resentBody.id).toBe(mintedBody.id);
      expect(resentBody.token).not.toBe(mintedBody.token);

      const password = 'correct-horse-battery';

      const oldTokenAttempt = await request(getTestServer(app))
        .post('/api/v1/auth/register')
        .send({ password, invitationToken: mintedBody.token });
      expect(oldTokenAttempt.status).toBe(400);

      const newTokenAttempt = await request(getTestServer(app))
        .post('/api/v1/auth/register')
        .send({ password, invitationToken: resentBody.token });
      expect(newTokenAttempt.status).toBe(201);
    });
  });
});
