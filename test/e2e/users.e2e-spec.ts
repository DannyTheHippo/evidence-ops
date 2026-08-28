import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { User, UserDocument } from '../../src/database/schemas/administration/user/user.schema';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface UserBody {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

const USER_KEYS = ['id', 'email', 'role', 'createdAt'].sort();
const password = 'correct-horse-battery';

describe('Users (e2e)', () => {
  let app: INestApplication;
  let adminCookie: string;
  let memberCookie: string;
  let tenantId: string;
  let memberUserId: string;
  let userModel: Model<UserDocument>;

  beforeAll(async () => {
    app = await createTestApp();
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));

    const admin = await registerTestUser(app, { email: 'users-admin-e2e@example.com', password });
    adminCookie = admin.cookie;
    tenantId = admin.tenantId;

    const member = await registerTestUser(
      app,
      { email: 'users-member-e2e@example.com', password },
      { role: 'member', tenantId },
    );
    memberCookie = member.cookie;
    memberUserId = member.userId;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /users', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/users');

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/users')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        expect.objectContaining({
          statusCode: 403,
          message: 'Insufficient role for this action',
          error: 'Forbidden',
        }),
      );
    });

    it('lists the tenant’s members with the exact key set, excluding the password', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/users')
        .set('Cookie', adminCookie);
      const body = response.body as { docs: UserBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      const listedMember = body.docs.find((doc) => doc.id === memberUserId);
      expect(listedMember).toBeDefined();
      expect(listedMember?.role).toBe(UserRole.Member);
      expect(Object.keys(listedMember as UserBody).sort()).toEqual(USER_KEYS);
      expect(listedMember).not.toHaveProperty('password');
      expect(listedMember).not.toHaveProperty('tokenVersion');
    });

    it('excludes a member belonging to a different tenant', async () => {
      const other = await registerTestUser(app, {
        email: 'users-other-tenant-e2e@example.com',
        password,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/users')
        .set('Cookie', adminCookie);
      const body = response.body as { docs: UserBody[]; count: number };

      expect(body.docs.find((doc) => doc.id === other.userId)).toBeUndefined();
    });

    it('paginates with skip and limit', async () => {
      const paged = await registerTestUser(app, { email: 'users-paged-e2e@example.com', password });
      for (let i = 0; i < 3; i += 1) {
        await registerTestUser(
          app,
          { email: `users-paged-member-${i}@example.com`, password },
          { role: 'member', tenantId: paged.tenantId },
        );
      }

      const firstPage = await request(getTestServer(app))
        .get('/api/v1/users?skip=0&limit=2')
        .set('Cookie', paged.cookie);
      const firstBody = firstPage.body as { docs: UserBody[]; count: number };

      const secondPage = await request(getTestServer(app))
        .get('/api/v1/users?skip=2&limit=2')
        .set('Cookie', paged.cookie);
      const secondBody = secondPage.body as { docs: UserBody[]; count: number };

      expect(firstBody.docs).toHaveLength(2);
      expect(firstBody.count).toBe(4);
      expect(secondBody.docs).toHaveLength(2);
      expect(secondBody.count).toBe(4);
    });
  });

  describe('PATCH /users/:id/role', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .patch(`/api/v1/users/${memberUserId}/role`)
        .send({ role: UserRole.Admin });

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .patch(`/api/v1/users/${memberUserId}/role`)
        .set('Cookie', memberCookie)
        .send({ role: UserRole.Admin });

      expect(response.status).toBe(403);
    });

    it('returns 404 for an id that does not exist in this tenant', async () => {
      const response = await request(getTestServer(app))
        .patch('/api/v1/users/000000000000000000000000/role')
        .set('Cookie', adminCookie)
        .send({ role: UserRole.Admin });

      expect(response.status).toBe(404);
    });

    it('changes a member’s role and returns the updated shape', async () => {
      const target = await registerTestUser(
        app,
        { email: 'users-role-change-e2e@example.com', password },
        { role: 'member', tenantId },
      );

      const response = await request(getTestServer(app))
        .patch(`/api/v1/users/${target.userId}/role`)
        .set('Cookie', adminCookie)
        .send({ role: UserRole.Admin });
      const body = response.body as UserBody;

      expect(response.status).toBe(200);
      expect(body.id).toBe(target.userId);
      expect(body.role).toBe(UserRole.Admin);
      expect(Object.keys(body).sort()).toEqual(USER_KEYS);

      const persisted = await userModel.findById(target.userId);
      expect(persisted?.role).toBe(UserRole.Admin);
    });

    it('refuses to demote the tenant’s sole remaining admin', async () => {
      const solo = await registerTestUser(app, {
        email: 'users-solo-admin-e2e@example.com',
        password,
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/users/${solo.userId}/role`)
        .set('Cookie', solo.cookie)
        .send({ role: UserRole.Member });

      expect(response.status).toBe(409);

      const persisted = await userModel.findById(solo.userId);
      expect(persisted?.role).toBe(UserRole.Admin);
    });

    /**
     * Smoke coverage against the real database and driver, not a proof: two concurrent requests
     * can simply serialize, in which case this passes whether or not the guard is correct — it
     * does not observe that an interleaving actually happened, and two mutual demotions can never
     * reach the three-request defect Fix 1 closes (that needs a third, retried write landing
     * between a guarded write and its own compensation). The deterministic branch tests in
     * `test/features/common/users/users.service.spec.ts` are what pin the invariant.
     */
    it('never lets a concurrent mutual demotion leave the tenant with zero admins', async () => {
      const first = await registerTestUser(app, {
        email: 'users-race-admin-1-e2e@example.com',
        password,
      });
      const second = await registerTestUser(
        app,
        { email: 'users-race-admin-2-e2e@example.com', password },
        { tenantId: first.tenantId },
      );

      const [firstResponse, secondResponse] = await Promise.all([
        request(getTestServer(app))
          .patch(`/api/v1/users/${second.userId}/role`)
          .set('Cookie', first.cookie)
          .send({ role: UserRole.Member }),
        request(getTestServer(app))
          .patch(`/api/v1/users/${first.userId}/role`)
          .set('Cookie', second.cookie)
          .send({ role: UserRole.Member }),
      ]);

      const statuses = [firstResponse.status, secondResponse.status];
      expect(statuses).not.toEqual([200, 200]);
      expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);

      const remainingAdmins = await userModel.countDocuments({
        tenantId: first.tenantId,
        role: UserRole.Admin,
      });
      expect(remainingAdmins).toBeGreaterThanOrEqual(1);
    });
  });

  describe('DELETE /users/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).delete(`/api/v1/users/${memberUserId}`);

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .delete(`/api/v1/users/${memberUserId}`)
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    it('returns 404 for an id that does not exist in this tenant', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/users/000000000000000000000000')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
    });

    it('removes a member from the tenant', async () => {
      const target = await registerTestUser(
        app,
        { email: 'users-removed-e2e@example.com', password },
        { role: 'member', tenantId },
      );

      const response = await request(getTestServer(app))
        .delete(`/api/v1/users/${target.userId}`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(204);
      const persisted = await userModel.findById(target.userId);
      expect(persisted).toBeNull();
    });

    it('refuses to remove the tenant’s sole remaining admin', async () => {
      const solo = await registerTestUser(app, {
        email: 'users-solo-admin-remove-e2e@example.com',
        password,
      });
      const before = await userModel.findById(solo.userId);

      const response = await request(getTestServer(app))
        .delete(`/api/v1/users/${solo.userId}`)
        .set('Cookie', solo.cookie);

      expect(response.status).toBe(409);

      const persisted = await userModel.findById(solo.userId);
      expect(persisted).not.toBeNull();
      expect(persisted?.role).toBe(UserRole.Admin);
      // The compensating insert bypasses `auditablePlugin`, so a refused removal must not rewrite
      // the row's provenance: same creation time, same (absent) creator, not the acting admin.
      expect(persisted?.createdAt).toEqual(before?.createdAt);
      expect(persisted?.createdBy).toEqual(before?.createdBy);
    });

    /**
     * Same shape as the role-change smoke test above, for removal instead of demotion — see that
     * test's doc comment for why this is coverage, not proof.
     */
    it('never lets a concurrent mutual removal leave the tenant with zero admins', async () => {
      const first = await registerTestUser(app, {
        email: 'users-race-remove-1-e2e@example.com',
        password,
      });
      const second = await registerTestUser(
        app,
        { email: 'users-race-remove-2-e2e@example.com', password },
        { tenantId: first.tenantId },
      );

      const [firstResponse, secondResponse] = await Promise.all([
        request(getTestServer(app))
          .delete(`/api/v1/users/${second.userId}`)
          .set('Cookie', first.cookie),
        request(getTestServer(app))
          .delete(`/api/v1/users/${first.userId}`)
          .set('Cookie', second.cookie),
      ]);

      const statuses = [firstResponse.status, secondResponse.status];
      expect(statuses).not.toEqual([204, 204]);
      expect(statuses.every((status) => status === 204 || status === 409)).toBe(true);

      const remainingAdmins = await userModel.countDocuments({
        tenantId: first.tenantId,
        role: UserRole.Admin,
      });
      expect(remainingAdmins).toBeGreaterThanOrEqual(1);
    });
  });
});
