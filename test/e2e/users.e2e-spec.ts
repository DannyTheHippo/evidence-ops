import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
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

    it('returns 400 for a sort field outside the declared allowlist', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/users')
        .query({ sort: 'password' })
        .set('Cookie', adminCookie);

      expect(response.status).toBe(400);
    });

    it('returns 400 for a sortDir outside asc/desc', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/users')
        .query({ sort: 'email', sortDir: 'ascending' })
        .set('Cookie', adminCookie);

      expect(response.status).toBe(400);
    });

    it('sorts by email ascending by default, and lets the caller switch to role', async () => {
      const owner = await registerTestUser(app, {
        email: 'users-sort-b-e2e@example.com',
        password,
      });
      await registerTestUser(
        app,
        { email: 'users-sort-c-e2e@example.com', password },
        { role: 'member', tenantId: owner.tenantId },
      );
      await registerTestUser(
        app,
        { email: 'users-sort-a-e2e@example.com', password },
        { tenantId: owner.tenantId },
      );

      const defaultResponse = await request(getTestServer(app))
        .get('/api/v1/users')
        .set('Cookie', owner.cookie);
      const defaultBody = defaultResponse.body as { docs: UserBody[]; count: number };

      expect(defaultResponse.status).toBe(200);
      expect(defaultBody.docs.map((doc) => doc.email)).toEqual([
        'users-sort-a-e2e@example.com',
        'users-sort-b-e2e@example.com',
        'users-sort-c-e2e@example.com',
      ]);

      const roleDescResponse = await request(getTestServer(app))
        .get('/api/v1/users')
        .query({ sort: 'role', sortDir: 'desc' })
        .set('Cookie', owner.cookie);
      const roleDescBody = roleDescResponse.body as { docs: UserBody[]; count: number };

      expect(roleDescResponse.status).toBe(200);
      // 'member' sorts after 'admin' lexicographically, so a descending sort puts the tenant's
      // sole member first.
      expect(roleDescBody.docs[0].role).toBe(UserRole.Member);
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
     * Against the real database and driver, not mocked: both requests demote a different admin in
     * the same tenant, so both transactions touch the same guard row on `Tenant`. Whichever loses
     * that write race aborts with a write conflict and retries against the state the winner
     * committed, where it sees the winner's demotion and refuses correctly — this is what the
     * shared marker exists to force, not a race that might simply serialize.
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

    /**
     * Proves the durability guarantee directly, without racing against timing: this drives the
     * exact write `UsersService.changeRole` performs, through a hand-held session whose transaction
     * is never committed — standing in for a process dying at that instant. A second, independent
     * read while the transaction is still open is what a concurrent request or a restarted process
     * would see, and it must find the row exactly as it stood before this call, because nothing a
     * transaction writes is visible or durable before it commits.
     */
    it('leaves the tenant’s sole admin durably unchanged if the process dies before a guarded demotion commits', async () => {
      const solo = await registerTestUser(app, {
        email: 'users-crash-window-role-e2e@example.com',
        password,
      });

      const connection = app.get<Connection>(getConnectionToken());
      const session = await connection.startSession();
      session.startTransaction();
      try {
        await userModel.updateOne(
          { _id: solo.userId, tenantId: solo.tenantId },
          { $set: { role: UserRole.Member } },
          { session },
        );

        const duringTransaction = await userModel.findById(solo.userId);
        expect(duringTransaction?.role).toBe(UserRole.Admin);
      } finally {
        // A crash exactly here never surfaces as a commit; aborting reproduces the same durable
        // outcome a real process death would leave behind.
        await session.abortTransaction();
        await session.endSession();
      }

      const afterAbort = await userModel.findById(solo.userId);
      expect(afterAbort?.role).toBe(UserRole.Admin);
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
      // The delete shares the aborted transaction, so a refused removal never touches the row at
      // all: same creation time, same (absent) creator, not the acting admin.
      expect(persisted?.createdAt).toEqual(before?.createdAt);
      expect(persisted?.createdBy).toEqual(before?.createdBy);
    });

    /**
     * Same shape as the role-change race test above, for removal instead of demotion — see that
     * test's doc comment for the write-conflict mechanics this exercises.
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

    /**
     * Same proof as the role-change durability test above, for removal instead of demotion: a
     * hand-held session drives the exact delete `UsersService.remove` performs, its transaction is
     * never committed, and a second, independent read while it is still open must still see the row
     * — nothing a transaction writes is visible or durable before it commits, so a process dying at
     * this instant leaves the tenant exactly as it stood before the call.
     */
    it('leaves the tenant’s sole admin durably in place if the process dies before a guarded removal commits', async () => {
      const solo = await registerTestUser(app, {
        email: 'users-crash-window-remove-e2e@example.com',
        password,
      });

      const connection = app.get<Connection>(getConnectionToken());
      const session = await connection.startSession();
      session.startTransaction();
      try {
        await userModel.deleteOne({ _id: solo.userId, tenantId: solo.tenantId }, { session });

        const duringTransaction = await userModel.findById(solo.userId);
        expect(duringTransaction).not.toBeNull();
        expect(duringTransaction?.role).toBe(UserRole.Admin);
      } finally {
        await session.abortTransaction();
        await session.endSession();
      }

      const afterAbort = await userModel.findById(solo.userId);
      expect(afterAbort).not.toBeNull();
      expect(afterAbort?.role).toBe(UserRole.Admin);
    });
  });

  describe('POST /users/:id/revoke-sessions', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).post(
        `/api/v1/users/${memberUserId}/revoke-sessions`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .post(`/api/v1/users/${memberUserId}/revoke-sessions`)
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    it('returns 404 for an id that does not exist in this tenant', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/users/000000000000000000000000/revoke-sessions')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
    });

    it('returns 404 for a member belonging to a different tenant', async () => {
      const other = await registerTestUser(app, {
        email: 'users-revoke-cross-tenant-e2e@example.com',
        password,
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/users/${other.userId}/revoke-sessions`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
    });

    /**
     * The property that matters: a revoked cookie stops authenticating anywhere, while a peer in
     * the same tenant is unaffected. Asserting only that `tokenVersion` incremented would prove the
     * write, not the revocation itself — this proves the guard that reads it back refuses.
     */
    it('invalidates the target’s existing session while leaving a peer’s session working', async () => {
      const target = await registerTestUser(
        app,
        { email: 'users-revoke-target-e2e@example.com', password },
        { role: 'member', tenantId },
      );
      const peer = await registerTestUser(
        app,
        { email: 'users-revoke-peer-e2e@example.com', password },
        { role: 'member', tenantId },
      );

      const response = await request(getTestServer(app))
        .post(`/api/v1/users/${target.userId}/revoke-sessions`)
        .set('Cookie', adminCookie);
      const body = response.body as UserBody;

      expect(response.status).toBe(200);
      expect(body.id).toBe(target.userId);
      expect(Object.keys(body).sort()).toEqual(USER_KEYS);

      const revokedProbe = await request(getTestServer(app))
        .get('/api/v1/auth/me')
        .set('Cookie', target.cookie);
      expect(revokedProbe.status).toBe(401);

      const peerProbe = await request(getTestServer(app))
        .get('/api/v1/auth/me')
        .set('Cookie', peer.cookie);
      expect(peerProbe.status).toBe(200);
    });

    it('moves the epoch forward again on a second revocation rather than reassigning it', async () => {
      const target = await registerTestUser(
        app,
        { email: 'users-revoke-twice-e2e@example.com', password },
        { role: 'member', tenantId },
      );

      const before = await userModel.findById(target.userId);

      await request(getTestServer(app))
        .post(`/api/v1/users/${target.userId}/revoke-sessions`)
        .set('Cookie', adminCookie);
      const afterFirst = await userModel.findById(target.userId);

      await request(getTestServer(app))
        .post(`/api/v1/users/${target.userId}/revoke-sessions`)
        .set('Cookie', adminCookie);
      const afterSecond = await userModel.findById(target.userId);

      expect(afterFirst?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
      expect(afterSecond?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 2);
    });
  });
});
