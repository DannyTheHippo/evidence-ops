import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Types } from 'mongoose';
import { Answer } from '../../../../src/database/schemas/evidence/answer/answer.schema';
import { Conflict } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { Measure } from '../../../../src/database/schemas/evidence/measure/measure.schema';
import { Verification } from '../../../../src/database/schemas/evidence/verification/verification.schema';
import {
  AttestationService,
  type AttestationBundle,
} from '../../../../src/features/evidence/attestations/attestation.service';
import {
  AttestationSubjectNotCompleteException,
  AttestationSubjectNotFoundException,
} from '../../../../src/features/evidence/attestations/exceptions/attestations.exception';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { canonicalJson } from '../../../../src/shared/utils/canonical-json.util';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

const TENANT = 'tenant-a';

/** Recomputes `integrity.contentHash` independently of `AttestationService`: its own `canonicalJson`
 * import (not a shared instance) and `createHash`, over the bundle with `integrity` removed by
 * destructuring rather than the implementation's spread trick — a second removal path that has to
 * agree with the first is a stronger proof of reproducibility than the same path run twice. */
function recomputeContentHash(bundle: AttestationBundle): string {
  // Rest-sibling destructuring: the picked key must be bound to something even though only `rest`
  // is read below.
  const { integrity: _integrity, ...rest } = bundle;
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex');
}

function buildAnswerDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: new Types.ObjectId(),
    tenantId: TENANT,
    questionText: 'What is the cap rate?',
    runStatus: 'completed',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
    claims: [],
    atoms: [],
    conflictIds: [],
    verificationReport: undefined,
    ...overrides,
  };
}

function buildVerificationDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: new Types.ObjectId(),
    tenantId: TENANT,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    claims: ['The cap rate is 6.10%.'],
    results: [{ claimIndex: 0, verdict: 'grounded' }],
    ...overrides,
  };
}

describe('AttestationService', () => {
  let service: AttestationService;
  const mockAnswerModel = getMockModel();
  const mockVerificationModel = getMockModel();
  const mockDocumentVersionModel = getMockModel();
  const mockExtractedFactModel = getMockModel();
  const mockConflictModel = getMockModel();
  const mockMeasureModel = getMockModel();
  const mockAuditService = { record: jest.fn() };
  const mockAls = { getStore: jest.fn() };
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    mockAls.getStore.mockReturnValue({ 'correlation-id': 'corr-1', user: 'actor-1' });
    mockDocumentVersionModel.find.mockResolvedValue([]);
    mockExtractedFactModel.find.mockResolvedValue([]);
    mockConflictModel.find.mockResolvedValue([]);
    mockMeasureModel.find.mockResolvedValue([]);
    mockAnswerModel.findOneAndUpdate.mockResolvedValue(undefined);
    mockVerificationModel.findOneAndUpdate.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttestationService,
        { provide: getModelToken(Answer.name), useValue: mockAnswerModel },
        { provide: getModelToken(Verification.name), useValue: mockVerificationModel },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
        { provide: getModelToken(Conflict.name), useValue: mockConflictModel },
        { provide: getModelToken(Measure.name), useValue: mockMeasureModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AsyncLocalStorage, useValue: mockAls },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<AttestationService>(AttestationService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('subject resolution', () => {
    it.each([
      ['answer' as const, () => service.exportForAnswer('not-an-object-id', TENANT)],
      ['verification' as const, () => service.exportForVerification('not-an-object-id', TENANT)],
    ])('rejects a malformed %s id without querying the model', async (_kind, run) => {
      await expect(run()).rejects.toBeInstanceOf(AttestationSubjectNotFoundException);
      expect(mockAnswerModel.findOne).not.toHaveBeenCalled();
      expect(mockVerificationModel.findOne).not.toHaveBeenCalled();
    });

    it('throws AttestationSubjectNotFoundException for a missing or cross-tenant answer', async () => {
      const id = new Types.ObjectId().toString();
      mockAnswerModel.findOne.mockResolvedValueOnce(null);

      await expect(service.exportForAnswer(id, TENANT)).rejects.toBeInstanceOf(
        AttestationSubjectNotFoundException,
      );
      expect(mockAnswerModel.findOne).toHaveBeenCalledWith({ _id: id, tenantId: TENANT });
    });

    it('throws AttestationSubjectNotFoundException for a missing or cross-tenant verification', async () => {
      const id = new Types.ObjectId().toString();
      mockVerificationModel.findOne.mockResolvedValueOnce(null);

      await expect(service.exportForVerification(id, TENANT)).rejects.toBeInstanceOf(
        AttestationSubjectNotFoundException,
      );
      expect(mockVerificationModel.findOne).toHaveBeenCalledWith({ _id: id, tenantId: TENANT });
    });

    it('throws AttestationSubjectNotCompleteException for a queued answer', async () => {
      const doc = buildAnswerDoc({ runStatus: 'queued', outcome: undefined });
      mockAnswerModel.findOne.mockResolvedValueOnce(doc);

      await expect(
        service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT),
      ).rejects.toBeInstanceOf(AttestationSubjectNotCompleteException);
    });
  });

  describe('exportForAnswer', () => {
    it('assembles survived and dropped claims, resolves documentId per citation, and pins the hash once', async () => {
      const versionObjectId = new Types.ObjectId();
      const survivedWithAtoms = {
        statement: 'The cap rate is 6.10%.',
        citations: [
          {
            docVersionId: versionObjectId.toString(),
            sha256: 'a'.repeat(64),
            chunkId: 'chunk-1',
            locator: { kind: 'pdf-page' as const, page: 3, extractorVersion: 'v1' },
            quote: 'at a cap rate of approximately 6.10%',
          },
        ],
      };
      const survivedNoAtoms = {
        statement: 'The vacancy rate is 4%.',
        citations: [
          {
            docVersionId: 'not-an-object-id',
            sha256: 'b'.repeat(64),
            chunkId: 'chunk-2',
            locator: {
              kind: 'text-block' as const,
              blockIndex: 0,
              extractorVersion: 'v1',
              headingPath: [],
            },
            quote: 'vacancy sits at 4%',
          },
        ],
      };
      const droppedWithAtoms = { statement: 'Dropped claim A', reason: 'quote-not-found' };
      const droppedNoAtoms = { statement: 'Dropped claim B', reason: 'chunk-not-retrieved' };
      const conflictId = new Types.ObjectId();
      const winningFactId = new Types.ObjectId();

      const doc = buildAnswerDoc({
        outcome: { kind: 'answered', claims: [survivedWithAtoms, survivedNoAtoms] },
        claims: [survivedWithAtoms, survivedNoAtoms],
        atoms: [
          { claimIndex: 0, statement: survivedWithAtoms.statement, atoms: ['6.10%'] },
          { claimIndex: 2, statement: droppedWithAtoms.statement, atoms: ['atom-x'] },
        ],
        conflictIds: [conflictId],
        verificationReport: {
          verifiedClaimCount: 2,
          totalClaimCount: 4,
          droppedClaims: [droppedWithAtoms, droppedNoAtoms],
        },
      });
      mockAnswerModel.findOne.mockResolvedValueOnce(doc);

      const documentId = new Types.ObjectId();
      mockDocumentVersionModel.find.mockResolvedValueOnce([{ _id: versionObjectId, documentId }]);

      const measureId = new Types.ObjectId();
      mockExtractedFactModel.find.mockResolvedValueOnce([{ chunkId: 'chunk-1', measureId }]);
      mockMeasureModel.find.mockResolvedValueOnce([
        { _id: measureId, slug: 'cap_rate', version: 3, status: 'confirmed' },
      ]);
      mockConflictModel.find.mockResolvedValueOnce([
        {
          _id: conflictId,
          factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-Q1' },
          resolution: {
            outcome: 'resolved',
            winningFactId,
            decidedBy: 'user-1',
            reason: 'authoritative source',
            resolvedAt: new Date('2026-07-15T00:00:00.000Z'),
            ruleFired: 'authority',
            followedProposal: true,
          },
        },
      ]);

      const bundle = await service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT);

      expect(bundle.kind).toBe('answer');
      expect(bundle.subject).toEqual({ question: 'What is the cap rate?' });
      expect(bundle.outcome).toBe('answered');
      expect(bundle.claims).toEqual([
        {
          statement: survivedWithAtoms.statement,
          atoms: ['6.10%'],
          verdict: 'survived',
          citations: [
            {
              documentId: documentId.toString(),
              documentVersionId: versionObjectId.toString(),
              sha256: 'a'.repeat(64),
              locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
              extractorVersion: 'v1',
              quote: 'at a cap rate of approximately 6.10%',
            },
          ],
          checks: [
            { name: 'retrieval-containment', passed: true },
            { name: 'quote-containment', passed: true },
            { name: 'quote-alignment', passed: true },
            { name: 'numeric-support', passed: true },
          ],
        },
        {
          statement: survivedNoAtoms.statement,
          verdict: 'survived',
          citations: [
            {
              documentId: null,
              documentVersionId: 'not-an-object-id',
              sha256: 'b'.repeat(64),
              locator: {
                kind: 'text-block',
                blockIndex: 0,
                extractorVersion: 'v1',
                headingPath: [],
              },
              extractorVersion: 'v1',
              quote: 'vacancy sits at 4%',
            },
          ],
          checks: [
            { name: 'retrieval-containment', passed: true },
            { name: 'quote-containment', passed: true },
            { name: 'quote-alignment', passed: true },
            { name: 'numeric-support', passed: true },
          ],
        },
        {
          statement: droppedWithAtoms.statement,
          atoms: ['atom-x'],
          verdict: 'dropped',
          citations: [],
          checks: [{ name: 'grounding-gate', passed: false, detail: 'quote-not-found' }],
        },
        {
          statement: droppedNoAtoms.statement,
          verdict: 'dropped',
          citations: [],
          checks: [{ name: 'grounding-gate', passed: false, detail: 'chunk-not-retrieved' }],
        },
      ]);
      expect(bundle.measures).toEqual([{ slug: 'cap_rate', version: 3, status: 'confirmed' }]);
      expect(bundle.decisions).toEqual([
        {
          conflictId: conflictId.toString(),
          factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-Q1' },
          outcome: 'resolved',
          winningFactId: winningFactId.toString(),
          decidedBy: 'user-1',
          reason: 'authoritative source',
          resolvedAt: '2026-07-15T00:00:00.000Z',
          ruleFired: 'authority',
          followedProposal: true,
        },
      ]);

      expect(bundle.integrity.contentHash).toBe(recomputeContentHash(bundle));
      expect(mockAnswerModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: (doc._id as Types.ObjectId).toString(),
          tenantId: TENANT,
          attestationHash: { $exists: false },
        },
        { $set: { attestationHash: bundle.integrity.contentHash } },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'attestations.exported',
        actorId: 'actor-1',
        subject: { entityType: 'Answer', entityId: (doc._id as Types.ObjectId).toString() },
        tenantId: TENANT,
      });
    });

    it('treats an absent outcome as a null outcome and skips every downstream lookup', async () => {
      const doc = buildAnswerDoc({ outcome: undefined });
      mockAnswerModel.findOne.mockResolvedValueOnce(doc);

      const bundle = await service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT);

      expect(bundle.outcome).toBeNull();
      expect(bundle.claims).toEqual([]);
      expect(bundle.decisions).toEqual([]);
      expect(bundle.measures).toEqual([]);
      expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
      expect(mockExtractedFactModel.find).not.toHaveBeenCalled();
      expect(mockConflictModel.find).not.toHaveBeenCalled();
    });

    it('merges a ledger decision conflictId into the decisions lookup alongside conflictIds', async () => {
      const conflictId = new Types.ObjectId().toString();
      const doc = buildAnswerDoc({
        outcome: {
          kind: 'answered',
          claims: [{ statement: 'x', citations: [] }],
          ledger: {
            entity: 'Northgate Business Park',
            measure: 'cap_rate',
            state: 'adjudicated',
            factId: new Types.ObjectId().toString(),
            decision: {
              conflictId,
              outcome: 'resolved',
              resolvedAt: '2026-07-01T00:00:00.000Z',
            },
          },
        },
        claims: [{ statement: 'x', citations: [] }],
        conflictIds: [],
      });
      mockAnswerModel.findOne.mockResolvedValueOnce(doc);

      await service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT);

      expect(mockConflictModel.find).toHaveBeenCalledWith({
        _id: { $in: [new Types.ObjectId(conflictId)] },
        tenantId: TENANT,
        resolution: { $exists: true },
      });
    });

    it('skips a returned conflict document that unexpectedly carries no resolution', async () => {
      const conflictId = new Types.ObjectId();
      const doc = buildAnswerDoc({ conflictIds: [conflictId] });
      mockAnswerModel.findOne.mockResolvedValueOnce(doc);
      mockConflictModel.find.mockResolvedValueOnce([
        { _id: conflictId, factKey: { entity: 'e', metric: 'm', period: 'p' } },
      ]);

      const bundle = await service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT);

      expect(bundle.decisions).toEqual([]);
    });
  });

  describe('exportForVerification', () => {
    it('indexes claims by claimIndex, maps verdict and citations, and leaves decisions empty', async () => {
      const documentId = new Types.ObjectId();
      const versionObjectId = new Types.ObjectId();
      const doc = buildVerificationDoc({
        claims: ['Statement A', 'Statement B'],
        results: [
          {
            claimIndex: 1,
            verdict: 'grounded',
            citations: [
              {
                docVersionId: versionObjectId.toString(),
                sha256: 'c'.repeat(64),
                chunkId: 'chunk-9',
                locator: { kind: 'pdf-page' as const, page: 1, extractorVersion: 'v1' },
                quote: 'a verified quote',
              },
            ],
          },
          { claimIndex: 0, verdict: 'not_grounded', reasonCode: 'quote-not-found' },
        ],
      });
      mockVerificationModel.findOne.mockResolvedValueOnce(doc);
      mockDocumentVersionModel.find.mockResolvedValueOnce([{ _id: versionObjectId, documentId }]);

      const bundle = await service.exportForVerification(
        (doc._id as Types.ObjectId).toString(),
        TENANT,
      );

      expect(bundle.kind).toBe('verification');
      expect(bundle.subject).toEqual({ claims: ['Statement A', 'Statement B'] });
      expect(bundle.outcome).toBeNull();
      expect(bundle.decisions).toEqual([]);
      expect(bundle.claims).toEqual([
        {
          statement: 'Statement B',
          verdict: 'grounded',
          citations: [
            {
              documentId: documentId.toString(),
              documentVersionId: versionObjectId.toString(),
              sha256: 'c'.repeat(64),
              locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
              extractorVersion: 'v1',
              quote: 'a verified quote',
            },
          ],
          checks: [{ name: 'grounding-gate', passed: true }],
        },
        {
          statement: 'Statement A',
          verdict: 'not_grounded',
          citations: [],
          checks: [{ name: 'grounding-gate', passed: false, detail: 'quote-not-found' }],
        },
      ]);
      expect(bundle.integrity.contentHash).toBe(recomputeContentHash(bundle));
    });

    it('pins attestationHash on the verification row and audits the export', async () => {
      const doc = buildVerificationDoc();
      mockVerificationModel.findOne.mockResolvedValueOnce(doc);

      const bundle = await service.exportForVerification(
        (doc._id as Types.ObjectId).toString(),
        TENANT,
      );

      expect(mockVerificationModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: (doc._id as Types.ObjectId).toString(),
          tenantId: TENANT,
          attestationHash: { $exists: false },
        },
        { $set: { attestationHash: bundle.integrity.contentHash } },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'attestations.exported',
        actorId: 'actor-1',
        subject: { entityType: 'Verification', entityId: (doc._id as Types.ObjectId).toString() },
        tenantId: TENANT,
      });
    });
  });

  describe('byte-identity and tamper', () => {
    it.each([
      [
        'answer' as const,
        () => {
          const doc = buildAnswerDoc();
          mockAnswerModel.findOne.mockResolvedValue(doc);
          return () => service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT);
        },
      ],
      [
        'verification' as const,
        () => {
          const doc = buildVerificationDoc();
          mockVerificationModel.findOne.mockResolvedValue(doc);
          return () =>
            service.exportForVerification((doc._id as Types.ObjectId).toString(), TENANT);
        },
      ],
    ])('two exports of an unchanged %s are byte-identical', async (_kind, setup) => {
      const run = setup();
      const first = await run();
      const second = await run();

      expect(canonicalJson(first)).toBe(canonicalJson(second));
      expect(first.integrity.contentHash).toBe(second.integrity.contentHash);
    });

    it('changes the hash when a claim statement is tampered with', async () => {
      const original = buildAnswerDoc({
        outcome: { kind: 'answered', claims: [{ statement: 'Original statement', citations: [] }] },
        claims: [{ statement: 'Original statement', citations: [] }],
      });
      mockAnswerModel.findOne.mockResolvedValueOnce(original);
      const originalBundle = await service.exportForAnswer(
        (original._id as Types.ObjectId).toString(),
        TENANT,
      );

      const tampered = buildAnswerDoc({
        _id: original._id,
        outcome: { kind: 'answered', claims: [{ statement: 'Tampered statement', citations: [] }] },
        claims: [{ statement: 'Tampered statement', citations: [] }],
      });
      mockAnswerModel.findOne.mockResolvedValueOnce(tampered);
      const tamperedBundle = await service.exportForAnswer(
        (original._id as Types.ObjectId).toString(),
        TENANT,
      );

      expect(tamperedBundle.integrity.contentHash).not.toBe(originalBundle.integrity.contentHash);
    });

    it('is insensitive to the key order of nested locator and factKey objects', async () => {
      const sharedId = new Types.ObjectId();
      const conflictId = new Types.ObjectId();
      const resolution = {
        outcome: 'resolved' as const,
        resolvedAt: new Date('2026-07-15T00:00:00.000Z'),
      };
      const buildDoc = (locator: Record<string, unknown>) =>
        buildAnswerDoc({
          _id: sharedId,
          outcome: {
            kind: 'answered',
            claims: [
              {
                statement: 'x',
                citations: [
                  { docVersionId: 'v', sha256: 'd'.repeat(64), chunkId: 'c', locator, quote: 'q' },
                ],
              },
            ],
          },
          claims: [
            {
              statement: 'x',
              citations: [
                { docVersionId: 'v', sha256: 'd'.repeat(64), chunkId: 'c', locator, quote: 'q' },
              ],
            },
          ],
          conflictIds: [conflictId],
        });

      const orderedLocator = { kind: 'pdf-page', page: 3, extractorVersion: 'v1' };
      const reorderedLocator = { extractorVersion: 'v1', page: 3, kind: 'pdf-page' };
      const orderedFactKey = { entity: 'e', metric: 'm', period: 'p' };
      const reorderedFactKey = { period: 'p', entity: 'e', metric: 'm' };

      mockAnswerModel.findOne.mockResolvedValueOnce(buildDoc(orderedLocator));
      mockConflictModel.find.mockResolvedValueOnce([
        { _id: conflictId, factKey: orderedFactKey, resolution },
      ]);
      const bundleA = await service.exportForAnswer(sharedId.toString(), TENANT);

      mockAnswerModel.findOne.mockResolvedValueOnce(buildDoc(reorderedLocator));
      mockConflictModel.find.mockResolvedValueOnce([
        { _id: conflictId, factKey: reorderedFactKey, resolution },
      ]);
      const bundleB = await service.exportForAnswer(sharedId.toString(), TENANT);

      expect(canonicalJson(bundleA)).toBe(canonicalJson(bundleB));
      expect(bundleA.integrity.contentHash).toBe(bundleB.integrity.contentHash);
    });
  });

  describe('hash domain', () => {
    // A fixed `_id` across every pair below, so a test that isolates one field (`producedAt`,
    // `subject`, `outcome`, `claims`, `decisions`, `measures`) does not also change `subjectId` as
    // a side effect of `buildAnswerDoc`'s own fresh-`ObjectId` default.
    const FIXED_ANSWER_ID = new Types.ObjectId();

    const baseline = () =>
      buildAnswerDoc({
        _id: FIXED_ANSWER_ID,
        outcome: { kind: 'answered', claims: [{ statement: 'Statement one', citations: [] }] },
        claims: [{ statement: 'Statement one', citations: [] }],
      });

    async function exportBundle(overrides: Record<string, unknown>): Promise<AttestationBundle> {
      const doc = baseline();
      Object.assign(doc, overrides);
      mockAnswerModel.findOne.mockResolvedValueOnce(doc);
      return service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT);
    }

    it('changes when subjectId changes', async () => {
      const a = await exportBundle({});
      const b = await exportBundle({ _id: new Types.ObjectId() });
      expect(a.integrity.contentHash).not.toBe(b.integrity.contentHash);
    });

    it('changes when producedAt changes', async () => {
      const a = await exportBundle({});
      const b = await exportBundle({ createdAt: new Date('2027-01-01T00:00:00.000Z') });
      expect(a.integrity.contentHash).not.toBe(b.integrity.contentHash);
    });

    it('changes when subject (questionText) changes', async () => {
      const a = await exportBundle({});
      const b = await exportBundle({ questionText: 'A different question?' });
      expect(a.integrity.contentHash).not.toBe(b.integrity.contentHash);
    });

    it('changes when outcome kind changes', async () => {
      const a = await exportBundle({});
      const b = await exportBundle({
        outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
        claims: [],
      });
      expect(a.integrity.contentHash).not.toBe(b.integrity.contentHash);
    });

    it('changes when claims change', async () => {
      const a = await exportBundle({});
      const b = await exportBundle({
        outcome: { kind: 'answered', claims: [{ statement: 'Statement two', citations: [] }] },
        claims: [{ statement: 'Statement two', citations: [] }],
      });
      expect(a.integrity.contentHash).not.toBe(b.integrity.contentHash);
    });

    it('changes when decisions change', async () => {
      const conflictId = new Types.ObjectId();
      const a = await exportBundle({ conflictIds: [conflictId] });

      mockConflictModel.find.mockResolvedValueOnce([
        {
          _id: conflictId,
          factKey: { entity: 'e', metric: 'm', period: 'p' },
          resolution: { outcome: 'resolved', resolvedAt: new Date('2026-07-15T00:00:00.000Z') },
        },
      ]);
      const b = await exportBundle({ conflictIds: [conflictId] });

      expect(a.integrity.contentHash).not.toBe(b.integrity.contentHash);
    });

    it('changes when measures change', async () => {
      const measureId = new Types.ObjectId();
      const doc = baseline();
      Object.assign(doc, {
        outcome: {
          kind: 'answered',
          claims: [
            {
              statement: 'Statement one',
              citations: [
                {
                  docVersionId: 'v',
                  sha256: 'e'.repeat(64),
                  chunkId: 'chunk-1',
                  locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
                  quote: 'q',
                },
              ],
            },
          ],
        },
        claims: [
          {
            statement: 'Statement one',
            citations: [
              {
                docVersionId: 'v',
                sha256: 'e'.repeat(64),
                chunkId: 'chunk-1',
                locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
                quote: 'q',
              },
            ],
          },
        ],
      });
      mockAnswerModel.findOne.mockResolvedValueOnce(doc);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      const a = await service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT);

      mockAnswerModel.findOne.mockResolvedValueOnce(doc);
      mockExtractedFactModel.find.mockResolvedValueOnce([{ chunkId: 'chunk-1', measureId }]);
      mockMeasureModel.find.mockResolvedValueOnce([
        { _id: measureId, slug: 'cap_rate', version: 1, status: 'confirmed' },
      ]);
      const b = await service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT);

      expect(a.integrity.contentHash).not.toBe(b.integrity.contentHash);
    });

    it('changes between an answer bundle and a verification bundle (kind)', async () => {
      const answerDoc = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValueOnce(answerDoc);
      const answerBundle = await service.exportForAnswer(
        (answerDoc._id as Types.ObjectId).toString(),
        TENANT,
      );

      const verificationDoc = buildVerificationDoc();
      mockVerificationModel.findOne.mockResolvedValueOnce(verificationDoc);
      const verificationBundle = await service.exportForVerification(
        (verificationDoc._id as Types.ObjectId).toString(),
        TENANT,
      );

      expect(answerBundle.integrity.contentHash).not.toBe(verificationBundle.integrity.contentHash);
    });
  });

  describe('audit actor resolution', () => {
    it('skips the audit row and logs a warning when the request context carries no actor', async () => {
      mockAls.getStore.mockReturnValue({ 'correlation-id': 'corr-1' });
      const doc = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValueOnce(doc);

      await service.exportForAnswer((doc._id as Types.ObjectId).toString(), TENANT);

      expect(mockAuditService.record).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
