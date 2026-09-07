import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Model } from 'mongoose';
import request from 'supertest';
import { Types } from 'mongoose';
import { TypedConfigService } from '../../src/config/environment/typed-config.service';
import {
  Document,
  DocumentDocument,
  type DocumentSourceClass,
} from '../../src/database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../src/database/schemas/evidence/document-version/document-version.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { Source, SourceDocument } from '../../src/database/schemas/evidence/source/source.schema';
import { SourcesService } from '../../src/features/evidence/sources/sources.service';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface SourceBody {
  id: string;
  name: string;
  kind: string;
  path: string;
  enabled: boolean;
  intervalMs?: number;
  lastSyncAt?: string;
  lastSyncStatus?: string;
  lastSyncError?: string;
  fileCount: number;
  connectivity: string;
  reachability: string;
  owner?: string;
  tracked: boolean;
  sourceClass: string;
  createdAt: string;
}

interface SourceFileStateBody {
  path: string;
  status: string;
  lastError?: string;
  mtimeMs: number;
}

interface SourceWithFileStatesBody extends SourceBody {
  fileStates: SourceFileStateBody[];
}

interface WorkflowRunBody {
  id: string;
  workflowId: string;
  workflowType?: string;
  status: string;
  errorMessage?: string;
  createdAt: string;
}

const SOURCE_KEYS = [
  'id',
  'name',
  'kind',
  'path',
  'enabled',
  'intervalMs',
  'lastSyncAt',
  'lastSyncStatus',
  'lastSyncError',
  'fileCount',
  'connectivity',
  'reachability',
  'owner',
  'tracked',
  'sourceClass',
  'createdAt',
  'fileStates',
].sort();

/** A file state with `lastError` set — the only state in which `lastError` is observable on the
 *  nested shape, for the same reason `FRESH_SOURCE_KEYS` exists for the source itself. */
const FAILED_FILE_STATE_KEYS = ['path', 'status', 'lastError', 'mtimeMs'].sort();

const OK_FILE_STATE_KEYS = ['path', 'status', 'mtimeMs'].sort();

/**
 * What a source that has never synced actually serializes to. `intervalMs`, `lastSyncAt`,
 * `lastSyncStatus` and `lastSyncError` are optional and undefined until a sweep sets them, and
 * `JSON.stringify` drops an undefined value rather than emitting a null — so they are absent from
 * the payload, matching how `WorkflowRunResponseDto`'s optional fields behave in
 * `approvals.e2e-spec.ts`. Asserting this set exactly is what catches a field leaking in that the
 * DTO never declared. `connectivity`/`reachability`/`tracked`/`sourceClass` are always present —
 * every one has a schema default applied at creation — and `owner` is present here too because
 * `CreateSourceRequestDto` requires it.
 */
const FRESH_SOURCE_KEYS = [
  'id',
  'name',
  'kind',
  'path',
  'enabled',
  'fileCount',
  'connectivity',
  'reachability',
  'owner',
  'tracked',
  'sourceClass',
  'createdAt',
].sort();

describe('Sources (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let memberCookie: string;
  let tenantId: string;
  let sourceModel: Model<SourceDocument>;
  let documentModel: Model<DocumentDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;
  let evidenceChunkModel: Model<EvidenceChunkDocument>;
  let sourcesService: SourcesService;
  /** Subdirectory name relative to the configured inbox root — what `Source.path` must carry, since
   *  `LocalFolderSourceConnector` resolves `relativePath` against its own root internally. */
  let withdrawalFixtureSubdir: string;
  let withdrawalFixtureDir: string;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = { email: 'sources-e2e@example.com', password: 'correct-horse-battery' };
    ({ cookie, tenantId } = await registerTestUser(app, credentials));

    // Registering provisions a brand-new tenant with the registrant as its admin. Co-tenanting the
    // member into that same tenant lets both callers see the same seeded rows, so only the role
    // (admin vs. member) is the variable under test — same technique as `documents.e2e-spec.ts`.
    const member = await registerTestUser(
      app,
      { email: 'sources-member-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    memberCookie = member.cookie;

    sourceModel = app.get<Model<SourceDocument>>(getModelToken(Source.name));
    documentModel = app.get<Model<DocumentDocument>>(getModelToken(Document.name));
    documentVersionModel = app.get<Model<DocumentVersionDocument>>(
      getModelToken(DocumentVersion.name),
    );
    evidenceChunkModel = app.get<Model<EvidenceChunkDocument>>(getModelToken(EvidenceChunk.name));
    sourcesService = app.get<SourcesService>(SourcesService);

    // `runSync`'s withdrawal guard matrix needs the REAL `LocalFolderSourceConnector` (never
    // overridden for e2e, unlike `WORKFLOW_ENGINE`/`RETRIEVAL_STORE`), so this block exercises it
    // against real files under a unique subdirectory of the configured inbox root — cleaned up in
    // `afterAll` per the file-hygiene rule against leftover fixtures.
    withdrawalFixtureSubdir = `e2e-withdrawal-${Date.now()}`;
    withdrawalFixtureDir = join(
      app.get(TypedConfigService).sources.inboxDir,
      withdrawalFixtureSubdir,
    );
    await mkdir(withdrawalFixtureDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(withdrawalFixtureDir, { recursive: true, force: true });
    await closeTestApp(app);
  });

  const OWNER = 'Jane Doe, IT';

  describe('POST /sources', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/sources')
        .send({ name: 'Deal Room Inbox', kind: 'local-folder', path: 'deal-room', owner: OWNER });

      expect(response.status).toBe(401);
    });

    it('creates a source, defaults the inventory fields, and exposes the exact key set', async () => {
      const name = `Deal Room ${Date.now()}`;

      const response = await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Cookie', cookie)
        .send({ name, kind: 'local-folder', path: 'deal-room', owner: OWNER });
      const body = response.body as SourceBody;

      expect(response.status).toBe(201);
      expect(body.name).toBe(name);
      expect(body.kind).toBe('local-folder');
      expect(body.enabled).toBe(true);
      expect(body.fileCount).toBe(0);
      expect(body.connectivity).toBe('connector');
      expect(body.reachability).toBe('live');
      expect(body.owner).toBe(OWNER);
      expect(body.tracked).toBe(true);
      expect(body.sourceClass).toBe('unclassified');
      expect(Object.keys(body).sort()).toEqual(FRESH_SOURCE_KEYS);
    });

    it('creates an inventory-only source with explicit connectivity/reachability/sourceClass', async () => {
      const name = `Inventory Only ${Date.now()}`;

      const response = await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Cookie', cookie)
        .send({
          name,
          kind: 'local-folder',
          path: 'deal-room',
          owner: OWNER,
          connectivity: 'manual',
          reachability: 'prohibited',
          tracked: false,
          sourceClass: 'pm-export',
        });
      const body = response.body as SourceBody;

      expect(response.status).toBe(201);
      expect(body.connectivity).toBe('manual');
      expect(body.reachability).toBe('prohibited');
      expect(body.tracked).toBe(false);
      expect(body.sourceClass).toBe('pm-export');
    });

    it('returns 400 when owner is omitted', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Cookie', cookie)
        .send({ name: `No Owner ${Date.now()}`, kind: 'local-folder', path: 'deal-room' });

      expect(response.status).toBe(400);
    });

    it('returns 409 for a duplicate name', async () => {
      const name = `Duplicate Source ${Date.now()}`;
      await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Cookie', cookie)
        .send({ name, kind: 'local-folder', path: 'deal-room', owner: OWNER });

      const response = await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Cookie', cookie)
        .send({ name, kind: 'local-folder', path: 'deal-room-2', owner: OWNER });

      expect(response.status).toBe(409);
    });

    // Regression for the T3 audit: creating a source configures ingestion for the whole tenant, so
    // it is admin-only, unlike document upload which any Member can already do.
    it('returns 403 for a Member', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Cookie', memberCookie)
        .send({
          name: `Member Source ${Date.now()}`,
          kind: 'local-folder',
          path: 'deal-room',
          owner: OWNER,
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /sources', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/sources');

      expect(response.status).toBe(401);
    });

    it('lists sources as { docs, count }', async () => {
      await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Cookie', cookie)
        .send({
          name: `Listed Source ${Date.now()}`,
          kind: 'local-folder',
          path: 'deal-room',
          owner: OWNER,
        });

      const response = await request(getTestServer(app))
        .get('/api/v1/sources')
        .set('Cookie', cookie);
      const body = response.body as { docs: SourceBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      expect(body.count).toBeGreaterThan(0);
      expect(body.docs.length).toBeGreaterThan(0);
    });

    it('filters to tracked: false sources, keeping them separate from the default list', async () => {
      const untrackedName = `Untracked Filter Source ${Date.now()}`;
      await sourceModel.create({
        name: untrackedName,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        tracked: false,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/sources')
        .query({ tracked: false })
        .set('Cookie', cookie);
      const body = response.body as { docs: SourceBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs.every((doc) => doc.tracked === false)).toBe(true);
      expect(body.docs.some((doc) => doc.name === untrackedName)).toBe(true);
    });

    it('filters to lastSyncStatus: failed sources', async () => {
      const failedName = `Failed Filter Source ${Date.now()}`;
      await sourceModel.create({
        name: failedName,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        lastSyncAt: new Date(),
        lastSyncStatus: 'failed',
        lastSyncError: 'connector refused an oversized file',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/sources')
        .query({ lastSyncStatus: 'failed' })
        .set('Cookie', cookie);
      const body = response.body as { docs: SourceBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs.every((doc) => doc.lastSyncStatus === 'failed')).toBe(true);
      expect(body.docs.some((doc) => doc.name === failedName)).toBe(true);
    });

    it('returns 400 for a sort field outside the declared allowlist', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/sources')
        .query({ sort: 'fileCount' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('returns 400 for a sortDir outside asc/desc', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/sources')
        .query({ sort: 'owner', sortDir: 'ascending' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('sorts by name ascending by default, and lets the caller switch to owner descending', async () => {
      const sortTenant = await registerTestUser(app, {
        email: 'sources-sort-e2e@example.com',
        password: 'correct-horse-battery',
      });
      const bSource = await sourceModel.create({
        name: 'Sort E2E B',
        kind: 'local-folder',
        path: 'deal-room',
        owner: 'owner-a',
        tenantId: sortTenant.tenantId,
      });
      const aSource = await sourceModel.create({
        name: 'Sort E2E A',
        kind: 'local-folder',
        path: 'deal-room',
        owner: 'owner-b',
        tenantId: sortTenant.tenantId,
      });

      const defaultResponse = await request(getTestServer(app))
        .get('/api/v1/sources')
        .set('Cookie', sortTenant.cookie);
      const defaultBody = defaultResponse.body as { docs: SourceBody[]; count: number };

      expect(defaultResponse.status).toBe(200);
      expect(defaultBody.docs.map((doc) => doc.name)).toEqual(['Sort E2E A', 'Sort E2E B']);

      const ownerDescResponse = await request(getTestServer(app))
        .get('/api/v1/sources')
        .query({ sort: 'owner', sortDir: 'desc' })
        .set('Cookie', sortTenant.cookie);
      const ownerDescBody = ownerDescResponse.body as { docs: SourceBody[]; count: number };

      expect(ownerDescResponse.status).toBe(200);
      expect(ownerDescBody.docs.map((doc) => doc.id)).toEqual([
        aSource._id.toString(),
        bSource._id.toString(),
      ]);
    });

    describe('q filter', () => {
      const TOKEN = `Q${Date.now()}`;

      let searchTenant: { cookie: string; tenantId: string };
      let nameOnlySource: SourceDocument;
      let pathOnlySource: SourceDocument;
      let ownerOnlySource: SourceDocument;
      let noMatchSource: SourceDocument;
      let dotLiteralSource: SourceDocument;
      let dotDistractorSource: SourceDocument;
      let parenLiteralSource: SourceDocument;
      let trackedComboSource: SourceDocument;
      let untrackedComboSource: SourceDocument;

      beforeAll(async () => {
        searchTenant = await registerTestUser(app, {
          email: 'sources-q-e2e@example.com',
          password: 'correct-horse-battery',
        });

        const create = (overrides: Partial<SourceDocument>) =>
          sourceModel.create({
            kind: 'local-folder',
            path: 'deal-room/generic',
            owner: 'Generic Owner',
            tenantId: searchTenant.tenantId,
            ...overrides,
          });

        nameOnlySource = await create({ name: `${TOKEN}NameOnly Source` });
        pathOnlySource = await create({
          name: 'Generic Path Source',
          path: `deal-room/${TOKEN}PathOnly`,
        });
        ownerOnlySource = await create({
          name: 'Generic Owner Source',
          owner: `${TOKEN}OwnerOnly Team`,
        });
        noMatchSource = await create({ name: 'Totally Unrelated Source' });
        dotLiteralSource = await create({ name: `${TOKEN}Data.Room` });
        dotDistractorSource = await create({ name: `${TOKEN}DataXRoom` });
        parenLiteralSource = await create({ name: `${TOKEN}Vendor(Co)` });
        trackedComboSource = await create({ name: `Combo ${TOKEN} Tracked`, tracked: true });
        untrackedComboSource = await create({ name: `Combo ${TOKEN} Untracked`, tracked: false });

        // Cross-tenant fixture, deliberately reusing the exact string every `nameOnlySource`
        // query below searches for, so a leak would show up as a second doc / count: 2.
        const crossTenant = await registerTestUser(app, {
          email: 'sources-q-cross-tenant-e2e@example.com',
          password: 'correct-horse-battery',
        });
        await sourceModel.create({
          name: `${TOKEN}NameOnly Source`,
          kind: 'local-folder',
          path: 'deal-room/generic',
          owner: 'Generic Owner',
          tenantId: crossTenant.tenantId,
        });
      });

      const listWithQ = (q: string, extra: Record<string, unknown> = {}) =>
        request(getTestServer(app))
          .get('/api/v1/sources')
          .query({ q, ...extra })
          .set('Cookie', searchTenant.cookie);

      it('matches on name', async () => {
        const response = await listWithQ(`${TOKEN}NameOnly`);
        const body = response.body as { docs: SourceBody[]; count: number };

        expect(response.status).toBe(200);
        expect(body.count).toBe(1);
        expect(body.docs.map((doc) => doc.id)).toEqual([nameOnlySource._id.toString()]);
      });

      it('matches on path', async () => {
        const response = await listWithQ(`${TOKEN}PathOnly`);
        const body = response.body as { docs: SourceBody[]; count: number };

        expect(response.status).toBe(200);
        expect(body.count).toBe(1);
        expect(body.docs.map((doc) => doc.id)).toEqual([pathOnlySource._id.toString()]);
      });

      it('matches on owner', async () => {
        const response = await listWithQ(`${TOKEN}OwnerOnly`);
        const body = response.body as { docs: SourceBody[]; count: number };

        expect(response.status).toBe(200);
        expect(body.count).toBe(1);
        expect(body.docs.map((doc) => doc.id)).toEqual([ownerOnlySource._id.toString()]);
      });

      it('matches case-insensitively', async () => {
        const response = await listWithQ(`${TOKEN}nameonly`.toLowerCase());
        const body = response.body as { docs: SourceBody[]; count: number };

        expect(response.status).toBe(200);
        expect(body.count).toBe(1);
        expect(body.docs.map((doc) => doc.id)).toEqual([nameOnlySource._id.toString()]);
      });

      it('treats a `.` in q as a literal character, not a wildcard', async () => {
        const response = await listWithQ(`${TOKEN}Data.Room`);
        const body = response.body as { docs: SourceBody[]; count: number };

        expect(response.status).toBe(200);
        expect(body.count).toBe(1);
        expect(body.docs.map((doc) => doc.id)).toEqual([dotLiteralSource._id.toString()]);
        expect(body.docs.some((doc) => doc.id === dotDistractorSource._id.toString())).toBe(false);
      });

      it('treats a `(` in q as a literal character rather than an unterminated group', async () => {
        const response = await listWithQ(`${TOKEN}Vendor(Co)`);
        const body = response.body as { docs: SourceBody[]; count: number };

        expect(response.status).toBe(200);
        expect(body.count).toBe(1);
        expect(body.docs.map((doc) => doc.id)).toEqual([parenLiteralSource._id.toString()]);
      });

      it('combines with tracked, narrowing within each of the two ADR-0019 lists independently', async () => {
        const trackedResponse = await listWithQ(`Combo ${TOKEN}`, { tracked: true });
        const trackedBody = trackedResponse.body as { docs: SourceBody[]; count: number };

        expect(trackedResponse.status).toBe(200);
        expect(trackedBody.count).toBe(1);
        expect(trackedBody.docs.map((doc) => doc.id)).toEqual([trackedComboSource._id.toString()]);

        const untrackedResponse = await listWithQ(`Combo ${TOKEN}`, { tracked: false });
        const untrackedBody = untrackedResponse.body as { docs: SourceBody[]; count: number };

        expect(untrackedResponse.status).toBe(200);
        expect(untrackedBody.count).toBe(1);
        expect(untrackedBody.docs.map((doc) => doc.id)).toEqual([
          untrackedComboSource._id.toString(),
        ]);
      });

      it('reports count as the filtered total, not the unfiltered tenant total', async () => {
        const unfilteredResponse = await request(getTestServer(app))
          .get('/api/v1/sources')
          .set('Cookie', searchTenant.cookie);
        const unfilteredBody = unfilteredResponse.body as { docs: SourceBody[]; count: number };

        const filteredResponse = await listWithQ(`${TOKEN}NameOnly`);
        const filteredBody = filteredResponse.body as { docs: SourceBody[]; count: number };

        expect(filteredBody.count).toBe(1);
        expect(unfilteredBody.count).toBeGreaterThan(filteredBody.count);
      });

      it('excludes a matching source from a different tenant', async () => {
        const response = await listWithQ(`${TOKEN}NameOnly`);
        const body = response.body as { docs: SourceBody[]; count: number };

        expect(body.count).toBe(1);
        expect(body.docs).toHaveLength(1);
        expect(body.docs[0].id).toBe(nameOnlySource._id.toString());
      });

      it('excludes a source that matches on none of the three fields', async () => {
        const response = await listWithQ(`${TOKEN}NameOnly`);
        const body = response.body as { docs: SourceBody[]; count: number };

        expect(body.docs.some((doc) => doc.id === noMatchSource._id.toString())).toBe(false);
      });
    });
  });

  describe('GET /sources/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const created = await sourceModel.create({
        name: `Get Auth Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
      });

      const response = await request(getTestServer(app)).get(
        `/api/v1/sources/${created._id.toString()}`,
      );

      expect(response.status).toBe(401);
    });

    /**
     * Seeds every optional field populated, which is the only state in which the full key set is
     * observable. Asserting it here is what actually gates `@Expose()` on the four sync fields — a
     * missing decorator on any of them is silently dropped from the payload with no error anywhere,
     * and a source that has never synced cannot detect it because those keys are legitimately
     * absent. The same reasoning applies to the nested `fileStates` entries: a file with no
     * `lastError` is what proves the field is genuinely optional there too, and a file with
     * `lastError` set is the only state in which that field is observable at all.
     */
    it('gets a fully-synced source and exposes the exact key set', async () => {
      const okFileState = {
        path: 'contracts/lease-agreement.pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 245_760,
        mtimeMs: 1_753_920_000_000,
        documentId: new Types.ObjectId(),
      };
      const failedFileState = {
        path: 'contracts/broken-scan.pdf',
        sha256: 'b'.repeat(64),
        sizeBytes: 8192,
        mtimeMs: 1_753_920_100_000,
        documentId: new Types.ObjectId(),
        lastError: "Could not resolve a document type for 'contracts/broken-scan.pdf'",
      };
      const created = await sourceModel.create({
        name: `Getter Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        intervalMs: 300_000,
        lastSyncAt: new Date(),
        lastSyncStatus: 'failed',
        lastSyncError: 'connector refused an oversized file',
        fileStates: [okFileState, failedFileState],
        owner: OWNER,
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/sources/${created._id.toString()}`)
        .set('Cookie', cookie);
      const body = response.body as SourceWithFileStatesBody;

      expect(response.status).toBe(200);
      expect(body.id).toBe(created._id.toString());
      expect(body.intervalMs).toBe(300_000);
      expect(body.lastSyncStatus).toBe('failed');
      expect(body.lastSyncError).toBe('connector refused an oversized file');
      expect(body.owner).toBe(OWNER);
      expect(body.connectivity).toBe('connector');
      expect(body.reachability).toBe('live');
      expect(body.tracked).toBe(true);
      expect(body.sourceClass).toBe('unclassified');
      expect(Object.keys(body).sort()).toEqual(SOURCE_KEYS);

      expect(body.fileStates).toHaveLength(2);
      const [ok, failed] = body.fileStates;
      expect(ok.path).toBe(okFileState.path);
      expect(ok.status).toBe('ok');
      expect(ok.mtimeMs).toBe(okFileState.mtimeMs);
      expect(Object.keys(ok).sort()).toEqual(OK_FILE_STATE_KEYS);

      expect(failed.path).toBe(failedFileState.path);
      expect(failed.status).toBe('failed');
      expect(failed.lastError).toBe(failedFileState.lastError);
      expect(failed.mtimeMs).toBe(failedFileState.mtimeMs);
      expect(Object.keys(failed).sort()).toEqual(FAILED_FILE_STATE_KEYS);
    });

    // The caller's token carries a real, freshly provisioned tenant id, so this only proves
    // isolation because that id genuinely differs from 'other-tenant'.
    it('returns 404 for a source belonging to a different tenant, not 403', async () => {
      const otherTenantSource = await sourceModel.create({
        name: `Other Tenant Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId: 'other-tenant',
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/sources/${otherTenantSource._id.toString()}`)
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /sources/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const created = await sourceModel.create({
        name: `Patch Auth Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/sources/${created._id.toString()}`)
        .send({ enabled: false });

      expect(response.status).toBe(401);
    });

    it('flips the enabled flag', async () => {
      const created = await sourceModel.create({
        name: `Patch Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        enabled: true,
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/sources/${created._id.toString()}`)
        .set('Cookie', cookie)
        .send({ enabled: false });
      const body = response.body as SourceBody;

      expect(response.status).toBe(200);
      expect(body.enabled).toBe(false);

      const stored = await sourceModel.findById(created._id);
      expect(stored?.enabled).toBe(false);
    });

    it('updates the inventory fields — connectivity, reachability, owner, tracked, sourceClass', async () => {
      const created = await sourceModel.create({
        name: `Patch Inventory Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/sources/${created._id.toString()}`)
        .set('Cookie', cookie)
        .send({
          connectivity: 'export-only',
          reachability: 'possible',
          owner: OWNER,
          tracked: false,
          sourceClass: 'crm-export',
        });
      const body = response.body as SourceBody;

      expect(response.status).toBe(200);
      expect(body.connectivity).toBe('export-only');
      expect(body.reachability).toBe('possible');
      expect(body.owner).toBe(OWNER);
      expect(body.tracked).toBe(false);
      expect(body.sourceClass).toBe('crm-export');
      // `enabled` was not in the request body, so it must be untouched by the partial update.
      expect(body.enabled).toBe(true);

      const stored = await sourceModel.findById(created._id);
      expect(stored?.tracked).toBe(false);
    });

    // The caller's token carries a real, freshly provisioned tenant id, so this only proves
    // isolation because that id genuinely differs from 'other-tenant'.
    it('returns 404 for a source belonging to a different tenant, not 403', async () => {
      const otherTenantSource = await sourceModel.create({
        name: `Other Tenant Patch Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId: 'other-tenant',
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/sources/${otherTenantSource._id.toString()}`)
        .set('Cookie', cookie)
        .send({ enabled: false });

      expect(response.status).toBe(404);
    });

    // Regression for the T3 audit: disabling a source silently halts corpus freshness for the
    // whole tenant, so it is admin-only, the same reasoning as `create`.
    it('returns 403 for a Member', async () => {
      const created = await sourceModel.create({
        name: `Member Patch Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        enabled: true,
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/sources/${created._id.toString()}`)
        .set('Cookie', memberCookie)
        .send({ enabled: false });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /sources/:id/sync', () => {
    it('rejects an unauthenticated request', async () => {
      const created = await sourceModel.create({
        name: `Sync Auth Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
      });

      const response = await request(getTestServer(app)).post(
        `/api/v1/sources/${created._id.toString()}/sync`,
      );

      expect(response.status).toBe(401);
    });

    it('starts a sync and returns a WorkflowRun-shaped body', async () => {
      const created = await sourceModel.create({
        name: `Sync Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/sources/${created._id.toString()}/sync`)
        .set('Cookie', cookie);
      const body = response.body as WorkflowRunBody;

      expect(response.status).toBe(202);
      expect(body.id).toBeDefined();
      expect(body.workflowId).toBeDefined();
      expect(body.status).toBeDefined();
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body).sort()).toEqual(
        ['id', 'workflowId', 'workflowType', 'status', 'createdAt'].sort(),
      );
      // The label the Runs list shows in place of the opaque workflow uuid.
      expect(body.workflowType).toBe('sync-source');
    });

    // The caller's token carries a real, freshly provisioned tenant id, so this only proves
    // isolation because that id genuinely differs from 'other-tenant'.
    it('returns 404 for a source belonging to a different tenant, not 403', async () => {
      const otherTenantSource = await sourceModel.create({
        name: `Other Tenant Sync Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId: 'other-tenant',
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/sources/${otherTenantSource._id.toString()}/sync`)
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    // Regression for the T3 audit's deliberate decision to leave this route ungated: syncing
    // operates a source an admin already configured and enabled, rather than changing that
    // configuration, so a Member is allowed here unlike `create`/PATCH above.
    it('starts a sync for a Member', async () => {
      const created = await sourceModel.create({
        name: `Member Sync Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/sources/${created._id.toString()}/sync`)
        .set('Cookie', memberCookie);

      expect(response.status).toBe(202);
    });
  });

  describe('GET /sources/:id/class-drift and POST /sources/:id/class-drift/apply', () => {
    /** Direct model write, following `seedDocumentWithVersion` in `documents.e2e-spec.ts` — a
     *  drift fixture only needs a document row with a source and a class, not a real ingested
     *  version. */
    const seedDriftDocument = (sourceId: Types.ObjectId, sourceClass: DocumentSourceClass) =>
      documentModel.create({
        title: `Drift Fixture ${Date.now()}-${Math.random()}`,
        sourceKind: 'txt',
        mimeType: 'text/plain',
        tenantId,
        sourceId,
        sourceClass,
      });

    it('rejects an unauthenticated request on both routes', async () => {
      const created = await sourceModel.create({
        name: `Drift Auth Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
      });

      const getResponse = await request(getTestServer(app)).get(
        `/api/v1/sources/${created._id.toString()}/class-drift`,
      );
      const applyResponse = await request(getTestServer(app)).post(
        `/api/v1/sources/${created._id.toString()}/class-drift/apply`,
      );

      expect(getResponse.status).toBe(401);
      expect(applyResponse.status).toBe(401);
    });

    it('reports count: 0 and no previousClass when sourceClass has never changed', async () => {
      const created = await sourceModel.create({
        name: `Never Changed Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/sources/${created._id.toString()}/class-drift`)
        .set('Cookie', cookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ count: 0 });
    });

    it('reports and applies drift scoped by the previous class, leaving a third class untouched', async () => {
      const created = await sourceModel.create({
        name: `Drift Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        sourceClass: 'memo',
      });

      const drifted = await Promise.all([
        seedDriftDocument(created._id, 'memo'),
        seedDriftDocument(created._id, 'memo'),
      ]);
      const untouched = await seedDriftDocument(created._id, 'report');

      // Changing sourceClass is what stamps previousSourceClass — the documents above were
      // ingested before this change and never get rewritten by it on their own.
      await request(getTestServer(app))
        .patch(`/api/v1/sources/${created._id.toString()}`)
        .set('Cookie', cookie)
        .send({ sourceClass: 'crm-export' });

      const reportResponse = await request(getTestServer(app))
        .get(`/api/v1/sources/${created._id.toString()}/class-drift`)
        .set('Cookie', cookie);

      expect(reportResponse.status).toBe(200);
      expect(reportResponse.body).toEqual({ previousClass: 'memo', count: 2 });

      const applyResponse = await request(getTestServer(app))
        .post(`/api/v1/sources/${created._id.toString()}/class-drift/apply`)
        .set('Cookie', cookie);

      expect(applyResponse.status).toBe(200);
      expect(applyResponse.body).toEqual({
        modifiedCount: 2,
        previousClass: 'memo',
        sourceClass: 'crm-export',
      });

      for (const document of drifted) {
        const stored = await documentModel.findById(document._id);
        expect(stored?.sourceClass).toBe('crm-export');
      }
      const untouchedStored = await documentModel.findById(untouched._id);
      expect(untouchedStored?.sourceClass).toBe('report');

      // The drift is fully reconciled now — a second report reads count: 0.
      const secondReportResponse = await request(getTestServer(app))
        .get(`/api/v1/sources/${created._id.toString()}/class-drift`)
        .set('Cookie', cookie);
      expect(secondReportResponse.body).toEqual({ previousClass: 'memo', count: 0 });
    });

    // Regression for the drift remedy: applying it rewrites already-ingested evidence metadata
    // tenant-wide, the same register as `create`/PATCH above, so it is admin-only.
    it('returns 403 for a Member applying drift', async () => {
      const created = await sourceModel.create({
        name: `Member Apply Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/sources/${created._id.toString()}/class-drift/apply`)
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    // The caller's token carries a real, freshly provisioned tenant id, so this only proves
    // isolation because that id genuinely differs from 'other-tenant'.
    it('returns 404 for a source belonging to a different tenant, on both routes', async () => {
      const otherTenantSource = await sourceModel.create({
        name: `Other Tenant Drift Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId: 'other-tenant',
      });

      const getResponse = await request(getTestServer(app))
        .get(`/api/v1/sources/${otherTenantSource._id.toString()}/class-drift`)
        .set('Cookie', cookie);
      const applyResponse = await request(getTestServer(app))
        .post(`/api/v1/sources/${otherTenantSource._id.toString()}/class-drift/apply`)
        .set('Cookie', cookie);

      expect(getResponse.status).toBe(404);
      expect(applyResponse.status).toBe(404);
    });
  });

  describe('runSync — withdrawal (real LocalFolderSourceConnector)', () => {
    it('withdraws a document version after two consecutive absent sweeps, retaining its chunks', async () => {
      await writeFile(join(withdrawalFixtureDir, 'keep.txt'), 'keep-me');
      await writeFile(join(withdrawalFixtureDir, 'target.txt'), 'withdraw-me');

      const created = await sourceModel.create({
        name: `Withdrawal Source ${Date.now()}`,
        kind: 'local-folder',
        path: withdrawalFixtureSubdir,
        tenantId,
      });

      // Sweep 1: both files present — both get ingested as new documents.
      await sourcesService.runSync(created._id.toString(), new Types.ObjectId());

      const synced = await sourceModel.findById(created._id);
      // `LocalFolderSourceConnector.listFiles` reports `relativePath` against ITS OWN root
      // (`config.sources.inboxDir`), not against `source.path` — so a source rooted at a
      // subdirectory still records the full subdirectory-prefixed path.
      const targetRelativePath = join(withdrawalFixtureSubdir, 'target.txt');
      const targetState = synced?.fileStates.find((state) => state.path === targetRelativePath);
      expect(targetState).toBeDefined();
      const targetDocument = await documentModel.findById(targetState?.documentId);
      expect(targetDocument).not.toBeNull();
      const targetVersion = await documentVersionModel.findById(targetDocument?.currentVersionId);
      expect(targetVersion).not.toBeNull();
      expect(targetVersion?.withdrawnAt).toBeUndefined();

      // Ingestion never runs under `FakeWorkflowEngine`, so seed the chunk this test verifies
      // survives withdrawal directly, following `documents.e2e-spec.ts`'s `seedChunk` pattern.
      await evidenceChunkModel.create({
        _id: `chunk-${targetVersion?._id.toString()}-1`,
        documentId: targetDocument?._id,
        documentVersionId: targetVersion?._id,
        tenantId,
        text: 'chunk text',
        tokenCount: 10,
        embedding: [0.1, 0.2, 0.3],
        locator: { kind: 'text-block', extractorVersion: 'v1', blockIndex: 0 },
        ingestionAttemptToken: new Types.ObjectId(),
      });

      await rm(join(withdrawalFixtureDir, 'target.txt'));

      // Sweep 2: target.txt absent for the first time — first strike only, not withdrawn yet.
      await sourcesService.runSync(created._id.toString(), new Types.ObjectId());
      const afterFirstAbsence = await documentVersionModel.findById(targetVersion?._id);
      expect(afterFirstAbsence?.withdrawnAt).toBeUndefined();

      // Sweep 3: second consecutive absent sweep — withdrawn now.
      await sourcesService.runSync(created._id.toString(), new Types.ObjectId());
      const afterSecondAbsence = await documentVersionModel.findById(targetVersion?._id);
      expect(afterSecondAbsence?.withdrawnAt).toBeInstanceOf(Date);
      expect(afterSecondAbsence?.withdrawnReason).toBe('source-file-absent');

      const chunk = await evidenceChunkModel.findOne({ documentVersionId: targetVersion?._id });
      expect(chunk).not.toBeNull();
    });

    it('suppresses withdrawal and records it when the listing is empty but known files exist', async () => {
      const emptyListingSubdir = `${withdrawalFixtureSubdir}-empty-listing`;
      const emptyListingDir = join(
        app.get(TypedConfigService).sources.inboxDir,
        emptyListingSubdir,
      );
      await mkdir(emptyListingDir, { recursive: true });
      await writeFile(join(emptyListingDir, 'only.txt'), 'only-file');

      const created = await sourceModel.create({
        name: `Empty Listing Source ${Date.now()}`,
        kind: 'local-folder',
        path: emptyListingSubdir,
        tenantId,
      });

      await sourcesService.runSync(created._id.toString(), new Types.ObjectId());
      const synced = await sourceModel.findById(created._id);
      const onlyRelativePath = join(emptyListingSubdir, 'only.txt');
      const onlyState = synced?.fileStates.find((state) => state.path === onlyRelativePath);
      expect(onlyState).toBeDefined();
      const onlyDocument = await documentModel.findById(onlyState?.documentId);
      expect(onlyDocument).not.toBeNull();
      const onlyVersion = await documentVersionModel.findById(onlyDocument?.currentVersionId);
      expect(onlyVersion).not.toBeNull();

      await rm(join(emptyListingDir, 'only.txt'));

      await sourcesService.runSync(created._id.toString(), new Types.ObjectId());

      const suppressed = await sourceModel.findById(created._id);
      expect(suppressed?.lastWithdrawalSuppressedReason).toBe('empty-listing');
      expect(suppressed?.lastWithdrawalSuppressedAt).toBeInstanceOf(Date);

      const stillLiveVersion = await documentVersionModel.findById(onlyVersion?._id);
      expect(stillLiveVersion?.withdrawnAt).toBeUndefined();

      await rm(emptyListingDir, { recursive: true, force: true });
    });

    it('forgets one location on the second absent sweep but does not withdraw while another location for the same document remains', async () => {
      const multiLocationSubdir = `${withdrawalFixtureSubdir}-multi-location`;
      const multiLocationDir = join(
        app.get(TypedConfigService).sources.inboxDir,
        multiLocationSubdir,
      );
      await mkdir(multiLocationDir, { recursive: true });
      await writeFile(join(multiLocationDir, 'shared-a.txt'), 'shared-bytes');
      await writeFile(join(multiLocationDir, 'shared-b.txt'), 'shared-bytes');

      const created = await sourceModel.create({
        name: `Multi Location Source ${Date.now()}`,
        kind: 'local-folder',
        path: multiLocationSubdir,
        tenantId,
      });

      // Sweep 1: both paths present with identical bytes — the second upload hits the tenant-wide
      // dedupe and records a second location on the document the first created, rather than
      // minting a second document.
      await sourcesService.runSync(created._id.toString(), new Types.ObjectId());

      const synced = await sourceModel.findById(created._id);
      const sharedARelativePath = join(multiLocationSubdir, 'shared-a.txt');
      const sharedBRelativePath = join(multiLocationSubdir, 'shared-b.txt');
      const sharedAState = synced?.fileStates.find((state) => state.path === sharedARelativePath);
      const sharedBState = synced?.fileStates.find((state) => state.path === sharedBRelativePath);
      expect(sharedAState?.documentId).toBeDefined();
      expect(sharedBState?.documentId?.toString()).toBe(sharedAState?.documentId?.toString());

      const sharedDocument = await documentModel.findById(sharedAState?.documentId);
      expect(sharedDocument?.locations).toHaveLength(2);
      const sharedVersion = await documentVersionModel.findById(sharedDocument?.currentVersionId);

      await rm(join(multiLocationDir, 'shared-a.txt'));

      // Sweep 2: shared-a.txt absent for the first time — first strike only.
      await sourcesService.runSync(created._id.toString(), new Types.ObjectId());
      // Sweep 3: second consecutive absent sweep — shared-a.txt's location is forgotten, but
      // shared-b.txt's location still names the same document, so it is never withdrawn.
      await sourcesService.runSync(created._id.toString(), new Types.ObjectId());

      const stillLiveVersion = await documentVersionModel.findById(sharedVersion?._id);
      expect(stillLiveVersion?.withdrawnAt).toBeUndefined();

      const afterForget = await documentModel.findById(sharedDocument?._id);
      expect(afterForget?.locations).toHaveLength(1);
      expect(afterForget?.locations[0]?.path).toBe(sharedBRelativePath);

      await rm(multiLocationDir, { recursive: true, force: true });
    });
  });
});
