import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import type { Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { coTenantUser, type CoTenantUserResult } from '../../scripts/lib/co-tenant-user';
import {
  ApiKey,
  ApiKeyDocument,
} from '../../src/database/schemas/administration/api-key/api-key.schema';
import { User, UserDocument } from '../../src/database/schemas/administration/user/user.schema';
import { MAX_ACTIVE_KEYS_PER_USER } from '../../src/features/platform/api-keys/api-keys.service';
import { TOKEN_VERIFIER } from '../../src/features/platform/api-keys/token-verifier.interface';
import type { TokenVerifier } from '../../src/features/platform/api-keys/token-verifier.interface';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface MintedKeyBody {
  id: string;
  name: string;
  token: string;
  tokenPrefix: string;
  expiresAt?: string;
  createdAt: string;
}

interface ApiKeyBody {
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
  createdAt: string;
}

const DEFAULT_TTL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// `expiresAt` defaults from config the moment `expiresAt` is omitted, so every mint response now
// carries it — the "no expiry" shape from before the default TTL landed no longer occurs.
const MINTED_KEY_KEYS = ['id', 'name', 'token', 'tokenPrefix', 'expiresAt', 'createdAt'].sort();
const LIST_KEY_KEYS_FRESH = ['id', 'name', 'tokenPrefix', 'expiresAt', 'createdAt'].sort();
const LIST_KEY_KEYS_FULL = [
  'id',
  'name',
  'tokenPrefix',
  'expiresAt',
  'revokedAt',
  'createdAt',
].sort();
const LIST_KEY_KEYS_USED = [
  'id',
  'name',
  'tokenPrefix',
  'expiresAt',
  'lastUsedAt',
  'createdAt',
].sort();

describe('ApiKeys (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let userId: string;
  let tenantId: string;
  let apiKeyModel: Model<ApiKeyDocument>;
  let userModel: Model<UserDocument>;
  let tokenVerifier: TokenVerifier;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = { email: 'api-keys-e2e@example.com', password: 'correct-horse-battery' };
    ({ cookie, userId, tenantId } = await registerTestUser(app, credentials));

    apiKeyModel = app.get<Model<ApiKeyDocument>>(getModelToken(ApiKey.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    tokenVerifier = app.get<TokenVerifier>(TOKEN_VERIFIER);
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('POST /api-keys', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .send({ name: 'CI integration' });

      expect(response.status).toBe(401);
    });

    it('mints a key, exposing the exact key set including the plaintext token exactly once, with expiresAt defaulted from config', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'CI integration' });
      const body = response.body as MintedKeyBody;

      expect(response.status).toBe(201);
      expect(body.name).toBe('CI integration');
      expect(body.token.startsWith('eo_pat_')).toBe(true);
      expect(body.tokenPrefix.startsWith('eo_pat_')).toBe(true);
      expect(Object.keys(body).sort()).toEqual(MINTED_KEY_KEYS);

      const expiresAtMs = new Date(body.expiresAt as string).getTime();
      const expectedMs = Date.now() + DEFAULT_TTL_DAYS * DAY_MS;
      expect(Math.abs(expiresAtMs - expectedMs)).toBeLessThan(60_000);

      const stored = await apiKeyModel.findById(body.id);
      expect(stored?.tokenHash).not.toBe(body.token);
      expect(stored?.tokenHash).toBe(createHash('sha256').update(body.token).digest('hex'));
    });

    it('mints a key with an explicit expiry inside the allowed window and exposes it exactly', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Expiring key', expiresAt: '2027-02-01T00:00:00.000Z' });
      const body = response.body as MintedKeyBody;

      expect(response.status).toBe(201);
      expect(body.expiresAt).toBe('2027-02-01T00:00:00.000Z');
      expect(Object.keys(body).sort()).toEqual(MINTED_KEY_KEYS);
    });

    it('rejects an expiry beyond the one-year maximum window', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Century key', expiresAt: '2099-01-01T00:00:00.000Z' });

      expect(response.status).toBe(400);
    });

    it('refuses minting once the caller reaches the active key cap', async () => {
      const capped = await registerTestUser(app, {
        email: 'api-keys-e2e-capped@example.com',
        password: 'correct-horse-battery',
      });

      for (let i = 0; i < MAX_ACTIVE_KEYS_PER_USER; i += 1) {
        const response = await request(getTestServer(app))
          .post('/api/v1/api-keys')
          .set('Cookie', capped.cookie)
          .send({ name: `Cap fixture ${i}` });
        expect(response.status).toBe(201);
      }

      const response = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', capped.cookie)
        .send({ name: 'One too many' });

      expect(response.status).toBe(409);
    });
  });

  describe('GET /api-keys', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/api-keys');

      expect(response.status).toBe(401);
    });

    it('lists only the caller’s own keys, metadata only, exact key set', async () => {
      await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Listed key' });

      const response = await request(getTestServer(app))
        .get('/api/v1/api-keys')
        .set('Cookie', cookie);
      const body = response.body as { docs: ApiKeyBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      expect(body.count).toBeGreaterThan(0);
      const listedKey = body.docs.find((doc) => doc.name === 'Listed key');
      expect(listedKey).toBeDefined();
      expect(listedKey).not.toHaveProperty('token');
      expect(listedKey).not.toHaveProperty('tokenHash');
      expect(Object.keys(listedKey as ApiKeyBody).sort()).toEqual(LIST_KEY_KEYS_FRESH);
    });

    it('does not list another user’s keys', async () => {
      const other = await registerTestUser(app, {
        email: 'api-keys-e2e-other@example.com',
        password: 'correct-horse-battery',
      });
      await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', other.cookie)
        .send({ name: 'Other user key' });

      const response = await request(getTestServer(app))
        .get('/api/v1/api-keys')
        .set('Cookie', cookie);
      const body = response.body as { docs: ApiKeyBody[]; count: number };

      expect(body.docs.find((doc) => doc.name === 'Other user key')).toBeUndefined();
    });

    it('exposes the exact key set for a revoked, expiring key (both optional fields present)', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Full shape key', expiresAt: '2027-02-01T00:00:00.000Z' });
      const mintedBody = minted.body as MintedKeyBody;

      await request(getTestServer(app))
        .delete(`/api/v1/api-keys/${mintedBody.id}`)
        .set('Cookie', cookie);

      const response = await request(getTestServer(app))
        .get('/api/v1/api-keys')
        .set('Cookie', cookie);
      const body = response.body as { docs: ApiKeyBody[]; count: number };
      const revokedKey = body.docs.find((doc) => doc.id === mintedBody.id);

      expect(revokedKey).toBeDefined();
      expect(revokedKey?.revokedAt).toBeDefined();
      expect(Object.keys(revokedKey as ApiKeyBody).sort()).toEqual(LIST_KEY_KEYS_FULL);
    });

    it('exposes lastUsedAt, exact key set, after a successful verify', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Used key' });
      const mintedBody = minted.body as MintedKeyBody;

      await tokenVerifier.verify(mintedBody.token);

      const response = await request(getTestServer(app))
        .get('/api/v1/api-keys')
        .set('Cookie', cookie);
      const body = response.body as { docs: ApiKeyBody[]; count: number };
      const usedKey = body.docs.find((doc) => doc.id === mintedBody.id);

      expect(usedKey).toBeDefined();
      expect(usedKey?.lastUsedAt).toBeDefined();
      expect(Object.keys(usedKey as ApiKeyBody).sort()).toEqual(LIST_KEY_KEYS_USED);
    });

    it('paginates with skip and limit', async () => {
      const paged = await registerTestUser(app, {
        email: 'api-keys-e2e-paged@example.com',
        password: 'correct-horse-battery',
      });
      for (let i = 0; i < 3; i += 1) {
        await request(getTestServer(app))
          .post('/api/v1/api-keys')
          .set('Cookie', paged.cookie)
          .send({ name: `Paged key ${i}` });
      }

      const firstPage = await request(getTestServer(app))
        .get('/api/v1/api-keys?skip=0&limit=2')
        .set('Cookie', paged.cookie);
      const firstBody = firstPage.body as { docs: ApiKeyBody[]; count: number };

      const secondPage = await request(getTestServer(app))
        .get('/api/v1/api-keys?skip=2&limit=2')
        .set('Cookie', paged.cookie);
      const secondBody = secondPage.body as { docs: ApiKeyBody[]; count: number };

      expect(firstBody.docs).toHaveLength(2);
      expect(firstBody.count).toBe(3);
      expect(secondBody.docs).toHaveLength(1);
      expect(secondBody.count).toBe(3);

      const firstIds = firstBody.docs.map((doc) => doc.id);
      const secondIds = secondBody.docs.map((doc) => doc.id);
      expect(firstIds).not.toEqual(expect.arrayContaining(secondIds));
    });

    it('returns 400 for a sort field outside the declared allowlist', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/api-keys')
        .query({ sort: 'tokenPrefix' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('returns 400 for a sortDir outside asc/desc', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/api-keys')
        .query({ sort: 'name', sortDir: 'ascending' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('sorts by name ascending when asked, instead of the createdAt-descending default', async () => {
      const sortUser = await registerTestUser(app, {
        email: 'api-keys-sort-e2e@example.com',
        password: 'correct-horse-battery',
      });
      const minted1 = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', sortUser.cookie)
        .send({ name: 'Zeta key' });
      const minted2 = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', sortUser.cookie)
        .send({ name: 'Alpha key' });
      const zetaId = (minted1.body as MintedKeyBody).id;
      const alphaId = (minted2.body as MintedKeyBody).id;

      const response = await request(getTestServer(app))
        .get('/api/v1/api-keys')
        .query({ sort: 'name', sortDir: 'asc' })
        .set('Cookie', sortUser.cookie);
      const body = response.body as { docs: ApiKeyBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs.map((doc) => doc.id)).toEqual([alphaId, zetaId]);
    });
  });

  describe('DELETE /api-keys/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Delete auth key' });
      const mintedBody = minted.body as MintedKeyBody;

      const response = await request(getTestServer(app)).delete(
        `/api/v1/api-keys/${mintedBody.id}`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 404 for a malformed id', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/api-keys/not-an-id')
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('returns 404, not 403, for another user’s key', async () => {
      const other = await registerTestUser(app, {
        email: 'api-keys-e2e-cross-user@example.com',
        password: 'correct-horse-battery',
      });
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', other.cookie)
        .send({ name: 'Not yours' });
      const mintedBody = minted.body as MintedKeyBody;

      const response = await request(getTestServer(app))
        .delete(`/api/v1/api-keys/${mintedBody.id}`)
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('revokes a key', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Revoke me' });
      const mintedBody = minted.body as MintedKeyBody;

      const response = await request(getTestServer(app))
        .delete(`/api/v1/api-keys/${mintedBody.id}`)
        .set('Cookie', cookie);

      expect(response.status).toBe(204);

      const stored = await apiKeyModel.findById(mintedBody.id);
      expect(stored?.revokedAt).toBeDefined();
    });
  });

  describe('POST /api-keys/:id/rotate', () => {
    it('rejects an unauthenticated request', async () => {
      // `JwtAuthGuard` refuses before the route param is ever read, so no key needs to exist for
      // this — an arbitrary, validly-shaped id proves the same 401.
      const response = await request(getTestServer(app)).post(
        `/api/v1/api-keys/${new Types.ObjectId().toString()}/rotate`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 404 for a malformed id', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/api-keys/not-an-id/rotate')
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('returns 404, not 403, for another user’s key', async () => {
      const other = await registerTestUser(app, {
        email: 'api-keys-e2e-rotate-cross-user@example.com',
        password: 'correct-horse-battery',
      });
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', other.cookie)
        .send({ name: 'Not yours to rotate' });
      const mintedBody = minted.body as MintedKeyBody;

      const response = await request(getTestServer(app))
        .post(`/api/v1/api-keys/${mintedBody.id}/rotate`)
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('returns 404 for an already-revoked key', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Revoked, then rotate attempt' });
      const mintedBody = minted.body as MintedKeyBody;
      await request(getTestServer(app))
        .delete(`/api/v1/api-keys/${mintedBody.id}`)
        .set('Cookie', cookie);

      const response = await request(getTestServer(app))
        .post(`/api/v1/api-keys/${mintedBody.id}/rotate`)
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    // The key is owned and identifiable, so it is distinguishable from a missing one — 409, not
    // the 404 an unknown or foreign id returns.
    it('returns 409 for a key whose expiresAt has passed, backdated through the model directly', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Expired, then rotate attempt' });
      const mintedBody = minted.body as MintedKeyBody;
      await apiKeyModel.updateOne(
        { _id: mintedBody.id },
        { $set: { expiresAt: new Date('2020-01-01T00:00:00.000Z') } },
      );

      const response = await request(getTestServer(app))
        .post(`/api/v1/api-keys/${mintedBody.id}/rotate`)
        .set('Cookie', cookie);

      expect(response.status).toBe(409);
      expect((response.body as { message: string }).message).toBe(
        `API key '${mintedBody.id}' has expired`,
      );
    });

    /**
     * The acceptance criterion for rotation, exercised in one lifecycle rather than split across
     * calls to stay inside this suite's shared per-handler request budget (`setup-env.ts`): the
     * response carries the exact mint key set with the same id and name, the old token
     * authenticates before rotation and is refused after, the rotated token authenticates in its
     * place, and no later read exposes either plaintext. The refuse-then-authenticate pair is what
     * catches a rotated key stamped with a stale or missing `tokenVersion` — a wrong epoch would
     * leave the rotated token 401ing on its very first use while `rotate` itself still reports
     * success.
     */
    it('rotates onto a fresh token that authenticates in place of the refused old one, exposing the exact mint key set', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Rotation lifecycle key' });
      const mintedBody = minted.body as MintedKeyBody;

      const beforeIdentity = await tokenVerifier.verify(mintedBody.token);
      expect(beforeIdentity).toEqual({
        userId,
        tenantId,
        role: UserRole.Admin,
        email: 'api-keys-e2e@example.com',
      });

      const rotateResponse = await request(getTestServer(app))
        .post(`/api/v1/api-keys/${mintedBody.id}/rotate`)
        .set('Cookie', cookie);
      const rotatedBody = rotateResponse.body as MintedKeyBody;

      expect(rotateResponse.status).toBe(201);
      expect(Object.keys(rotatedBody).sort()).toEqual(MINTED_KEY_KEYS);
      expect(rotatedBody.id).toBe(mintedBody.id);
      expect(rotatedBody.name).toBe(mintedBody.name);
      expect(rotatedBody.token).not.toBe(mintedBody.token);

      const afterOldIdentity = await tokenVerifier.verify(mintedBody.token);
      expect(afterOldIdentity).toBeNull();

      const rotatedIdentity = await tokenVerifier.verify(rotatedBody.token);
      expect(rotatedIdentity).toEqual({
        userId,
        tenantId,
        role: UserRole.Admin,
        email: 'api-keys-e2e@example.com',
      });

      const listResponse = await request(getTestServer(app))
        .get('/api/v1/api-keys')
        .set('Cookie', cookie);
      const listBody = listResponse.body as { docs: ApiKeyBody[]; count: number };
      const listedKey = listBody.docs.find((doc) => doc.id === mintedBody.id);
      expect(listedKey).toBeDefined();
      expect(listedKey).not.toHaveProperty('token');
    });
  });

  /**
   * There is no HTTP route that accepts a personal access token — `JwtAuthGuard` stays untouched
   * by this change; the MCP surface (`src/mcp/pat-token.verifier.ts`) authenticates every call
   * with a personal access token instead of the SPA's session cookie. The `mint → use → revoke →
   * refused` chain, live role resolution, and expiry are all exercised through `TOKEN_VERIFIER`
   * directly, exactly as the MCP surface calls it.
   */
  describe('TOKEN_VERIFIER', () => {
    it('verifies a freshly minted token to the minting user’s identity', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Verifier key' });
      const mintedBody = minted.body as MintedKeyBody;

      const identity = await tokenVerifier.verify(mintedBody.token);

      // `email` rides along so an MCP-originated approval request can name a person in the
      // reviewer's inbox rather than a bare account id.
      expect(identity).toEqual({
        userId,
        tenantId,
        role: UserRole.Admin,
        email: 'api-keys-e2e@example.com',
      });
    });

    it('refuses a revoked token', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Revoked verifier key' });
      const mintedBody = minted.body as MintedKeyBody;
      await request(getTestServer(app))
        .delete(`/api/v1/api-keys/${mintedBody.id}`)
        .set('Cookie', cookie);

      const identity = await tokenVerifier.verify(mintedBody.token);

      expect(identity).toBeNull();
    });

    it('refuses an expired token', async () => {
      const rawToken = `eo_pat_expired-token-fixture-${Date.now()}`;
      await apiKeyModel.create({
        tenantId,
        userId,
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        tokenPrefix: rawToken.slice(0, 13),
        name: 'Expired fixture',
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        // Stamped by `ApiKeysService.mint` on a real key; supplied here because the schema requires
        // it and this fixture writes the row directly.
        tokenVersion: 0,
      });

      const identity = await tokenVerifier.verify(rawToken);

      expect(identity).toBeNull();
    });

    it('refuses an unrecognized token', async () => {
      const identity = await tokenVerifier.verify('eo_pat_never-minted-fixture');

      expect(identity).toBeNull();
    });

    /**
     * The `User` row, not the key, is the authority on the identity a token resolves to — and on
     * whether it resolves to one at all. A demotion is reflected on the next call, and raising
     * `tokenVersion` refuses the key outright. That second half is what makes the session epoch a
     * revocation lever over every credential an account holds: a personal access token is the MCP
     * surface's only credential, so an epoch that moved the browser session alone would leave a
     * compromised account holding a working one.
     */
    it('resolves identity live from the User row, reflecting a demotion and refusing a raised session epoch', async () => {
      const minted = await request(getTestServer(app))
        .post('/api/v1/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'Role-live key' });
      const mintedBody = minted.body as MintedKeyBody;

      const beforeIdentity = await tokenVerifier.verify(mintedBody.token);
      expect(beforeIdentity?.role).toBe(UserRole.Admin);

      await userModel.updateOne({ _id: userId }, { role: UserRole.Member });

      const afterIdentity = await tokenVerifier.verify(mintedBody.token);
      expect(afterIdentity?.role).toBe(UserRole.Member);

      await userModel.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });

      expect(await tokenVerifier.verify(mintedBody.token)).toBeNull();

      // Restore for any later test in this file that assumes the registered admin role and the
      // epoch its keys were minted at.
      await userModel.updateOne(
        { _id: userId },
        { role: UserRole.Admin, $inc: { tokenVersion: -1 } },
      );
    });
  });

  /**
   * The operator co-tenanting path (`scripts/lib/co-tenant-user.ts`) is the only way a user changes
   * tenant. A key row carries the tenant it was minted under and `list`/`revoke` match that against
   * the caller's session tenant — reinforced by `tenantScopePlugin`, which intersects the session
   * tenant into those queries regardless of what the service filter asks for — so the key rows have
   * to move with their owner. A key left behind in the vacated tenant keeps authenticating while
   * being invisible and unrevokable to the person who minted it.
   */
  describe('co-tenanting a key owner', () => {
    const movedUser = {
      email: 'api-keys-e2e-moved@example.com',
      password: 'correct-horse-battery',
    };
    let moveResult: CoTenantUserResult;
    let movedCookie: string;
    let targetTenantId: string;
    let survivingKey: MintedKeyBody;
    let verifiedKey: MintedKeyBody;

    beforeAll(async () => {
      const mover = await registerTestUser(app, movedUser);
      // Registration is what creates the target tenant's `tenants` registry row — the move refuses
      // a tenant id that is not registered.
      const target = await registerTestUser(app, {
        email: 'api-keys-e2e-move-target@example.com',
        password: 'correct-horse-battery',
      });
      targetTenantId = target.tenantId;

      const mint = async (name: string): Promise<MintedKeyBody> => {
        const response = await request(getTestServer(app))
          .post('/api/v1/api-keys')
          .set('Cookie', mover.cookie)
          .send({ name });
        return response.body as MintedKeyBody;
      };
      survivingKey = await mint('Survives a tenant move');
      verifiedKey = await mint('Verifies after a tenant move');

      const db = app.get<Connection>(getConnectionToken()).db;
      if (!db) {
        throw new Error('co-tenanting e2e: the Mongoose connection exposes no driver database');
      }
      moveResult = await coTenantUser(db, movedUser.email, targetTenantId);

      // The pre-move session cookie still carries the vacated tenant; the owner's next login is
      // where the move takes effect for every session-scoped query.
      const login = await request(getTestServer(app)).post('/api/v1/auth/login').send(movedUser);
      const setCookieHeader = login.headers['set-cookie'] as unknown as string[];
      movedCookie = setCookieHeader
        .find((value) => value.startsWith('eo_session='))
        ?.split(';')[0] as string;
    });

    it('moves the owner’s keys alongside the owner', () => {
      expect(moveResult).toEqual(expect.objectContaining({ outcome: 'moved', apiKeysMoved: 2 }));
    });

    it('keeps a key listable and revocable by its owner across a tenant move', async () => {
      const listResponse = await request(getTestServer(app))
        .get('/api/v1/api-keys')
        .set('Cookie', movedCookie);
      const body = listResponse.body as { docs: ApiKeyBody[]; count: number };

      expect(listResponse.status).toBe(200);
      expect(body.docs.find((doc) => doc.id === survivingKey.id)).toBeDefined();

      const revokeResponse = await request(getTestServer(app))
        .delete(`/api/v1/api-keys/${survivingKey.id}`)
        .set('Cookie', movedCookie);

      expect(revokeResponse.status).toBe(204);
    });

    it('verifies a moved owner’s key against the tenant they now belong to', async () => {
      const identity = await tokenVerifier.verify(verifiedKey.token);

      expect(identity?.tenantId).toBe(targetTenantId);
    });
  });
});
