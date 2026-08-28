import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import {
  CanonicalEntity,
  CanonicalEntityDocument,
  type HarvestedAliasStatus,
} from '../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import {
  ExtractedFact,
  type ExtractedFactDocument,
} from '../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { CanonicalEntityService } from '../../src/features/evidence/facts/canonical-entity.service';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface HarvestedAliasBody {
  alias: string;
  status: string;
  quote: string;
  locator: { kind: string; page: number; extractorVersion: string };
  documentVersionId: string;
  harvestedAt: string;
}

interface CanonicalEntityBody {
  id: string;
  canonicalName: string;
  aliases: string[];
  harvestedAliases: HarvestedAliasBody[];
  createdAt: string;
}

const CANONICAL_ENTITY_KEYS = [
  'id',
  'canonicalName',
  'aliases',
  'harvestedAliases',
  'createdAt',
].sort();

const HARVESTED_ALIAS_KEYS = [
  'alias',
  'status',
  'quote',
  'locator',
  'documentVersionId',
  'harvestedAt',
].sort();

describe('Canonical Entities (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let memberCookie: string;
  let tenantId: string;
  let canonicalEntityModel: Model<CanonicalEntityDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = {
      email: 'canonical-entities-e2e@example.com',
      password: 'correct-horse-battery',
    };
    ({ cookie, tenantId } = await registerTestUser(app, credentials));

    // Co-tenanting the member the same way `documents.e2e-spec.ts` does — both callers see
    // the same seeded rows, so only the role (admin vs. member) is the variable under test.
    const member = await registerTestUser(
      app,
      { email: 'canonical-entities-member-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    memberCookie = member.cookie;

    canonicalEntityModel = app.get<Model<CanonicalEntityDocument>>(
      getModelToken(CanonicalEntity.name),
    );
    extractedFactModel = app.get<Model<ExtractedFactDocument>>(getModelToken(ExtractedFact.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /canonical-entities', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/canonical-entities');

      expect(response.status).toBe(401);
    });

    it('lists the tenant-registered rows as { docs, count }, exposing the exact key set', async () => {
      await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Northgate Business Park',
        aliases: ['Northgate Bus. Park'],
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/canonical-entities')
        .set('Cookie', cookie);
      const body = response.body as { docs: CanonicalEntityBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBeGreaterThan(0);
      const row = body.docs.find((doc) => doc.canonicalName === 'Northgate Business Park');
      expect(row).toBeDefined();
      expect(row?.aliases).toEqual(['Northgate Bus. Park']);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose(), or catches `canonicalNameNormalized`/`aliasesNormalized` leaking through —
      // such a field is silently dropped or silently exposed with no error anywhere.
      expect(Object.keys(row!).sort()).toEqual(CANONICAL_ENTITY_KEYS);
    });

    it('is reachable by a Member — authoring is admin-only, reading is not', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/canonical-entities')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(200);
    });

    it('returns 400 for a sort field outside the declared allowlist', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/canonical-entities')
        .query({ sort: 'canonicalName' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('returns 400 for a sortDir outside asc/desc', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/canonical-entities')
        .query({ sort: 'createdAt', sortDir: 'ascending' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('sorts by canonicalNameNormalized ascending by default', async () => {
      const sortTenant = await registerTestUser(app, {
        email: 'canonical-entities-sort-e2e@example.com',
        password: 'correct-horse-battery',
      });
      const zeta = await canonicalEntityModel.create({
        tenantId: sortTenant.tenantId,
        canonicalName: 'Zeta Business Park',
      });
      const alpha = await canonicalEntityModel.create({
        tenantId: sortTenant.tenantId,
        canonicalName: 'Alpha Business Park',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/canonical-entities')
        .set('Cookie', sortTenant.cookie);
      const body = response.body as { docs: CanonicalEntityBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs.map((doc) => doc.id)).toEqual([alpha._id.toString(), zeta._id.toString()]);
    });
  });

  describe('POST /canonical-entities', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .send({ canonicalName: 'Sablewood Retail Court' });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', memberCookie)
        .send({ canonicalName: 'Sablewood Retail Court' });

      expect(response.status).toBe(403);
    });

    it('creates a row and exposes the exact key set', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Sablewood Retail Court', aliases: ['Sablewood'] });
      const body = response.body as CanonicalEntityBody;

      expect(response.status).toBe(201);
      expect(body.canonicalName).toBe('Sablewood Retail Court');
      expect(body.aliases).toEqual(['Sablewood']);
      expect(Object.keys(body).sort()).toEqual(CANONICAL_ENTITY_KEYS);
    });

    /**
     * The acceptance bar this step exists for: a duplicate canonical name must surface as a
     * feature exception, never as an unhandled 500 from a raw `MongoServerError` E11000 —
     * `GlobalExceptionFilter` collapses any non-`HttpException` to a 500 that loses the detail.
     */
    it('returns 409, not 500, for a duplicate canonical name', async () => {
      await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Duplicate Plaza' });

      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Duplicate Plaza' });

      expect(response.status).toBe(409);
    });
  });

  describe('PATCH /canonical-entities/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Patch Auth Test',
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/canonical-entities/${entity._id.toString()}`)
        .send({ canonicalName: 'Renamed' });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Patch Forbidden Test',
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/canonical-entities/${entity._id.toString()}`)
        .set('Cookie', memberCookie)
        .send({ canonicalName: 'Renamed' });

      expect(response.status).toBe(403);
    });

    it('returns 404 for an id with no row in this tenant', async () => {
      const response = await request(getTestServer(app))
        .patch('/api/v1/canonical-entities/65f1c2e4a1b2c3d4e5f6a7b8')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Renamed' });

      expect(response.status).toBe(404);
    });

    /**
     * The assertion that catches the stale-normalized-field trap: `CanonicalEntity`'s
     * `pre('validate')` hook derives `canonicalNameNormalized`/`aliasesNormalized`, and only
     * fires on a document `.save()`, not on a `findOneAndUpdate`-style write. A PATCH that used
     * the latter would rewrite `canonicalName` while leaving `canonicalNameNormalized` stale, so
     * the row would silently stop resolving under its new name — passing the response-body
     * assertions below while failing the resolver check that actually matters.
     */
    it('renames an entity and leaves the row resolvable by its new name', async () => {
      const created = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Old Plaza Name', aliases: ['Old Plaza Alias'] });
      const { id } = created.body as CanonicalEntityBody;

      const response = await request(getTestServer(app))
        .patch(`/api/v1/canonical-entities/${id}`)
        .set('Cookie', cookie)
        .send({ canonicalName: 'New Plaza Name' });
      const body = response.body as CanonicalEntityBody;

      expect(response.status).toBe(200);
      expect(body.canonicalName).toBe('New Plaza Name');
      expect(Object.keys(body).sort()).toEqual(CANONICAL_ENTITY_KEYS);

      const canonicalEntityService = app.get(CanonicalEntityService);
      const resolvedByNewName = await canonicalEntityService.resolve('New Plaza Name', tenantId);
      expect(resolvedByNewName).toEqual({ name: 'New Plaza Name', matched: true });

      const resolvedByOldName = await canonicalEntityService.resolve('Old Plaza Name', tenantId);
      expect(resolvedByOldName).toEqual({ name: 'Old Plaza Name', matched: false });

      // The alias set survives a rename that omits `aliases` from the request body.
      const resolvedByAlias = await canonicalEntityService.resolve('Old Plaza Alias', tenantId);
      expect(resolvedByAlias).toEqual({ name: 'New Plaza Name', matched: true });
    });
  });

  describe('DELETE /canonical-entities/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Delete Auth Test',
      });

      const response = await request(getTestServer(app)).delete(
        `/api/v1/canonical-entities/${entity._id.toString()}`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Delete Forbidden Test',
      });

      const response = await request(getTestServer(app))
        .delete(`/api/v1/canonical-entities/${entity._id.toString()}`)
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    it('returns 404 for an id with no row in this tenant', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/canonical-entities/65f1c2e4a1b2c3d4e5f6a7b8')
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('deletes the row, which no longer resolves', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Delete Target Plaza',
      });

      const response = await request(getTestServer(app))
        .delete(`/api/v1/canonical-entities/${entity._id.toString()}`)
        .set('Cookie', cookie);
      expect(response.status).toBe(204);

      const stored = await canonicalEntityModel.findOne({ _id: entity._id, tenantId });
      expect(stored).toBeNull();

      const canonicalEntityService = app.get(CanonicalEntityService);
      const resolved = await canonicalEntityService.resolve('Delete Target Plaza', tenantId);
      expect(resolved).toEqual({ name: 'Delete Target Plaza', matched: false });
    });
  });

  describe('POST /canonical-entities/:id/harvested-aliases/revoke', () => {
    // A distinct alias per row: two rows carrying the same applied alias would resolve to two
    // canonical names, and `resolve` refuses that outright — an ambiguity assertion, not the
    // registration assertion these cases are making.
    const seedEntity = (canonicalName: string, status: HarvestedAliasStatus, alias: string) =>
      canonicalEntityModel.create({
        tenantId,
        canonicalName,
        harvestedAliases: [
          {
            alias,
            aliasNormalized: alias.toLowerCase(),
            status,
            quote: `${canonicalName} (the "${alias}")`,
            locator: { kind: 'pdf-page', page: 4, extractorVersion: 'pdf-1' },
            documentVersionId: new Types.ObjectId(),
            harvestedAt: new Date('2026-07-02T00:00:00.000Z'),
          },
        ],
      });

    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities/65f1c2e4a1b2c3d4e5f6a7b8/harvested-aliases/revoke')
        .send({ alias: 'Property' });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const entity = await seedEntity('Revoke Forbidden Park', 'applied', 'ForbiddenTerm');

      const response = await request(getTestServer(app))
        .post(`/api/v1/canonical-entities/${entity._id.toString()}/harvested-aliases/revoke`)
        .set('Cookie', memberCookie)
        .send({ alias: 'ForbiddenTerm' });

      expect(response.status).toBe(403);
    });

    it('returns 404 when the row carries no harvested alias by that name', async () => {
      const entity = await seedEntity('Revoke Missing Alias Park', 'applied', 'MissingTerm');

      const response = await request(getTestServer(app))
        .post(`/api/v1/canonical-entities/${entity._id.toString()}/harvested-aliases/revoke`)
        .set('Cookie', cookie)
        .send({ alias: 'Seller' });

      expect(response.status).toBe(404);
    });

    it('exposes a harvested alias with its citation, and stops resolving by it once revoked', async () => {
      const entity = await seedEntity('Harvest Target Park', 'applied', 'Property');
      const canonicalEntityService = app.get(CanonicalEntityService);

      // `applied` is the status the schema hook folds into `aliasesNormalized`, so the alias
      // resolves through the ordinary lookup — and only in the exact form registered.
      expect(await canonicalEntityService.resolve('Property', tenantId)).toEqual({
        name: 'Harvest Target Park',
        matched: true,
      });
      expect(await canonicalEntityService.resolve('the Property', tenantId)).toEqual({
        name: 'the Property',
        matched: false,
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/canonical-entities/${entity._id.toString()}/harvested-aliases/revoke`)
        .set('Cookie', cookie)
        .send({ alias: 'Property' });
      const body = response.body as CanonicalEntityBody;

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(CANONICAL_ENTITY_KEYS);
      expect(Object.keys(body.harvestedAliases[0]).sort()).toEqual(HARVESTED_ALIAS_KEYS);
      expect(body.harvestedAliases[0]).toEqual({
        alias: 'Property',
        status: 'revoked',
        quote: 'Harvest Target Park (the "Property")',
        locator: { kind: 'pdf-page', page: 4, extractorVersion: 'pdf-1' },
        // Recast rather than bare `expect.any(String)` inside the object literal — its `any`-typed
        // return trips `no-unsafe-assignment` wherever it lands in one.
        documentVersionId: expect.any(String) as string,
        harvestedAt: '2026-07-02T00:00:00.000Z',
      });

      expect(await canonicalEntityService.resolve('Property', tenantId)).toEqual({
        name: 'Property',
        matched: false,
      });
    });

    /**
     * A harvested alias reaches resolution only by being folded into `aliasesNormalized`, the same
     * field an operator-authored alias lands in — so it meets `resolve`'s ambiguity branch head on
     * rather than routing around it. Asserted against real Mongoose, with the pre-validate hook
     * actually running, because that fold is the whole of the non-bypass claim.
     */
    it('leaves an alias applied on two different rows unresolved, not resolved to either', async () => {
      await seedEntity('Ambiguity Park North', 'applied', 'SharedTerm');
      await seedEntity('Ambiguity Park South', 'applied', 'SharedTerm');
      const canonicalEntityService = app.get(CanonicalEntityService);

      expect(await canonicalEntityService.resolve('SharedTerm', tenantId)).toEqual({
        name: 'SharedTerm',
        matched: false,
      });
      expect(await canonicalEntityService.resolveMany(['SharedTerm'], tenantId)).toEqual([
        { name: 'SharedTerm', matched: false },
      ]);
    });

    it('records a proposed alias without letting it resolve', async () => {
      await seedEntity('Proposal Only Park', 'proposed', 'ProposedTerm');
      const canonicalEntityService = app.get(CanonicalEntityService);

      const response = await request(getTestServer(app))
        .get('/api/v1/canonical-entities')
        .set('Cookie', cookie);
      const body = response.body as { docs: CanonicalEntityBody[] };
      const row = body.docs.find((doc) => doc.canonicalName === 'Proposal Only Park');

      expect(row?.harvestedAliases).toHaveLength(1);
      expect(row?.harvestedAliases[0].status).toBe('proposed');
      expect(await canonicalEntityService.resolve('ProposedTerm', tenantId)).toEqual({
        name: 'ProposedTerm',
        matched: false,
      });
    });
  });

  describe('POST /canonical-entities/:id/harvested-aliases/apply', () => {
    const seedEntity = (canonicalName: string, status: HarvestedAliasStatus, alias: string) =>
      canonicalEntityModel.create({
        tenantId,
        canonicalName,
        harvestedAliases: [
          {
            alias,
            aliasNormalized: alias.toLowerCase(),
            status,
            quote: `${canonicalName} (the "${alias}")`,
            locator: { kind: 'pdf-page', page: 4, extractorVersion: 'pdf-1' },
            documentVersionId: new Types.ObjectId(),
            harvestedAt: new Date('2026-07-02T00:00:00.000Z'),
          },
        ],
      });

    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities/65f1c2e4a1b2c3d4e5f6a7b8/harvested-aliases/apply')
        .send({ alias: 'Property' });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const entity = await seedEntity('Apply Forbidden Park', 'proposed', 'ForbiddenTerm');

      const response = await request(getTestServer(app))
        .post(`/api/v1/canonical-entities/${entity._id.toString()}/harvested-aliases/apply`)
        .set('Cookie', memberCookie)
        .send({ alias: 'ForbiddenTerm' });

      expect(response.status).toBe(403);
    });

    it('returns 404 when the row carries no harvested alias by that name', async () => {
      const entity = await seedEntity('Apply Missing Alias Park', 'proposed', 'MissingTerm');

      const response = await request(getTestServer(app))
        .post(`/api/v1/canonical-entities/${entity._id.toString()}/harvested-aliases/apply`)
        .set('Cookie', cookie)
        .send({ alias: 'Seller' });

      expect(response.status).toBe(404);
    });

    it('returns 409 for an alias that is already applied, rather than re-applying it', async () => {
      const entity = await seedEntity('Apply Already Applied Park', 'applied', 'AppliedTerm');

      const response = await request(getTestServer(app))
        .post(`/api/v1/canonical-entities/${entity._id.toString()}/harvested-aliases/apply`)
        .set('Cookie', cookie)
        .send({ alias: 'AppliedTerm' });

      expect(response.status).toBe(409);
    });

    it('applies a proposed alias so it resolves, exposing the exact key set', async () => {
      const entity = await seedEntity('Apply Target Park', 'proposed', 'Property');
      const canonicalEntityService = app.get(CanonicalEntityService);

      expect(await canonicalEntityService.resolve('Property', tenantId)).toEqual({
        name: 'Property',
        matched: false,
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/canonical-entities/${entity._id.toString()}/harvested-aliases/apply`)
        .set('Cookie', cookie)
        .send({ alias: 'Property' });
      const body = response.body as CanonicalEntityBody;

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(CANONICAL_ENTITY_KEYS);
      expect(Object.keys(body.harvestedAliases[0]).sort()).toEqual(HARVESTED_ALIAS_KEYS);
      expect(body.harvestedAliases[0].status).toBe('applied');

      expect(await canonicalEntityService.resolve('Property', tenantId)).toEqual({
        name: 'Apply Target Park',
        matched: true,
      });
    });

    /**
     * The registry can grow between a proposal being raised and an operator confirming it. This
     * asserts the asymmetry: applying is refused rather than silently landing a second row's worth
     * of this alias — which would immediately meet `resolve`'s own ambiguity branch and leave the
     * name unresolved everywhere, including on the rival row that already legitimately owns it.
     */
    it('returns 409 rather than applying into a name a rival row already owns, leaving the rival resolving alone', async () => {
      const entity = await seedEntity('Apply Ambiguous Park', 'proposed', 'AmbiguousTerm');
      await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Apply Ambiguous Park Rival',
        aliases: ['AmbiguousTerm'],
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/canonical-entities/${entity._id.toString()}/harvested-aliases/apply`)
        .set('Cookie', cookie)
        .send({ alias: 'AmbiguousTerm' });

      expect(response.status).toBe(409);

      const stored = await canonicalEntityModel.findOne({ _id: entity._id, tenantId });
      expect(stored?.harvestedAliases[0].status).toBe('proposed');

      // The rival's own authored alias resolves exactly as it did before the refused apply — the
      // guard left the registry untouched rather than fabricating a two-row ambiguity.
      const canonicalEntityService = app.get(CanonicalEntityService);
      expect(await canonicalEntityService.resolve('AmbiguousTerm', tenantId)).toEqual({
        name: 'Apply Ambiguous Park Rival',
        matched: true,
      });
    });
  });

  describe('POST /canonical-entities/near-matches/scan', () => {
    const seedUnresolvedFact = (entity: string, rawText: string) =>
      extractedFactModel.create({
        factKey: { entity, metric: 'noi', period: '2026' },
        value: { amount: 1_200_000, unit: 'usd' },
        groupKeyNormalized: `${entity.toLowerCase()}::noi::2026`,
        rawText,
        confidence: 0.9,
        extractionMethod: 'regex',
        packId: 'core',
        packVersion: 1,
        chunkId: 'chunk-1',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', page: 2, extractorVersion: 'pdf-1' },
        tenantId,
        entityMatched: false,
      });

    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).post(
        '/api/v1/canonical-entities/near-matches/scan',
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities/near-matches/scan')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    /**
     * The acceptance bar this step exists for: a corpus producing "Near Match Tower" and "Near
     * Match Tower, LLC" yields a confirmable proposal, never a silent merge — and the negative
     * direction that matters more, a genuinely different entity is never proposed as a match.
     */
    it('proposes a suffix-only near match for review, and never a genuinely different entity', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Near Match Tower',
      });
      await seedUnresolvedFact(
        'Near Match Tower, LLC',
        'Near Match Tower, LLC reported NOI of $1.2M.',
      );
      await seedUnresolvedFact('Near Match Plaza', 'Near Match Plaza reported NOI of $900K.');

      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities/near-matches/scan')
        .set('Cookie', cookie);
      const body = response.body as { proposed: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['proposed']);
      expect(body.proposed).toBe(1);

      const list = await request(getTestServer(app))
        .get('/api/v1/canonical-entities')
        .set('Cookie', cookie);
      const listBody = list.body as { docs: CanonicalEntityBody[] };
      const row = listBody.docs.find((doc) => doc.id === entity._id.toString());

      expect(row?.harvestedAliases).toHaveLength(1);
      expect(row?.harvestedAliases[0]).toMatchObject({
        alias: 'Near Match Tower, LLC',
        status: 'proposed',
        quote: 'Near Match Tower, LLC reported NOI of $1.2M.',
      });

      // Not proposed on this row, or fabricated onto any other — the negative direction a queue
      // that proposes noise would otherwise turn into a silent merge with extra steps.
      const nearMatchPlazaProposed = listBody.docs.some((doc) =>
        doc.harvestedAliases.some((alias) => alias.alias === 'Near Match Plaza'),
      );
      expect(nearMatchPlazaProposed).toBe(false);

      // The proposal is confirmable — one click away from resolving — never silently applied.
      const canonicalEntityService = app.get(CanonicalEntityService);
      expect(await canonicalEntityService.resolve('Near Match Tower, LLC', tenantId)).toEqual({
        name: 'Near Match Tower, LLC',
        matched: false,
      });

      const applied = await request(getTestServer(app))
        .post(`/api/v1/canonical-entities/${entity._id.toString()}/harvested-aliases/apply`)
        .set('Cookie', cookie)
        .send({ alias: 'Near Match Tower, LLC' });
      expect(applied.status).toBe(200);

      expect(await canonicalEntityService.resolve('Near Match Tower, LLC', tenantId)).toEqual({
        name: 'Near Match Tower',
        matched: true,
      });
    });
  });
});
