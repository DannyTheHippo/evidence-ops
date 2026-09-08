import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { EvidenceChunk } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { LedgerService } from '../../../../src/features/evidence/ledger/ledger.service';
import { LedgerAnswerService } from '../../../../src/features/evidence/qa/ledger-answer.service';
import { QuestionResolverService } from '../../../../src/features/evidence/qa/question-resolver.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger, type MockLogger } from '../../../utils/get-mock-logger';
import { getMockModel, type MockModel } from '../../../utils/get-mock-model';

const TENANT_ID = 'acme-corp';
const SHA256_A = 'a'.repeat(64);

function buildFact(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: 'unstated' },
    value: { amount: 6.25, unit: 'percent' },
    rawText: '6.25%',
    chunkId: 'chunk-1',
    documentVersionId: new Types.ObjectId(),
    locator: { kind: 'xlsx-cell', sheetName: 'Comps', cell: 'B2', extractorVersion: 'v1' },
    tenantId: TENANT_ID,
    ...overrides,
  };
}

function buildChunk(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'chunk-1',
    documentId: new Types.ObjectId(),
    documentVersionId: new Types.ObjectId(),
    text: ['| Property | Cap Rate |', '| --- | --- |', '| Northgate Business Park | 6.25% |'].join(
      '\n',
    ),
    locator: { kind: 'xlsx-region', sheetName: 'Comps', range: 'A1:B2', extractorVersion: 'v1' },
    tenantId: TENANT_ID,
    ...overrides,
  };
}

function buildVersion(overrides: Record<string, unknown> = {}) {
  return { _id: new Types.ObjectId(), sha256: SHA256_A, tenantId: TENANT_ID, ...overrides };
}

interface Harness {
  readonly service: LedgerAnswerService;
  readonly questionResolver: { resolve: jest.Mock };
  readonly ledgerService: { resolveValue: jest.Mock };
  readonly extractedFactModel: MockModel;
  readonly evidenceChunkModel: MockModel;
  readonly documentVersionModel: MockModel;
  readonly logger: MockLogger;
}

async function buildHarness(): Promise<Harness> {
  const questionResolver = { resolve: jest.fn() };
  const ledgerService = { resolveValue: jest.fn() };
  const extractedFactModel = getMockModel();
  const evidenceChunkModel = getMockModel();
  const documentVersionModel = getMockModel();
  const logger = getMockLogger();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      LedgerAnswerService,
      { provide: QuestionResolverService, useValue: questionResolver },
      { provide: LedgerService, useValue: ledgerService },
      { provide: getModelToken(ExtractedFact.name), useValue: extractedFactModel },
      { provide: getModelToken(EvidenceChunk.name), useValue: evidenceChunkModel },
      { provide: getModelToken(DocumentVersion.name), useValue: documentVersionModel },
      { provide: AppLogger, useValue: logger },
    ],
  }).compile();

  return {
    service: module.get(LedgerAnswerService),
    questionResolver,
    ledgerService,
    extractedFactModel,
    evidenceChunkModel,
    documentVersionModel,
    logger,
  };
}

describe('LedgerAnswerService', () => {
  it('should return unresolved, without ever calling the ledger, when the question does not resolve', async () => {
    const harness = await buildHarness();
    harness.questionResolver.resolve.mockResolvedValueOnce({
      kind: 'unresolved',
      reason: 'no-entity',
    });

    const result = await harness.service.resolve({
      questionText: 'What is the cap rate?',
      tenantId: TENANT_ID,
    });

    expect(result).toEqual({ kind: 'unresolved', reason: 'no-entity' });
    expect(harness.ledgerService.resolveValue).not.toHaveBeenCalled();
  });

  it('should return unresolved for a ledger cell with no value', async () => {
    const harness = await buildHarness();
    harness.questionResolver.resolve.mockResolvedValueOnce({
      kind: 'resolved',
      entity: 'Northgate Business Park',
      measure: 'cap_rate',
    });
    harness.ledgerService.resolveValue.mockResolvedValueOnce({
      entity: 'Northgate Business Park',
      measure: 'cap_rate',
      period: 'unstated',
      state: 'unknown',
      factIds: [],
      citations: [],
    });

    const result = await harness.service.resolve({
      questionText: 'What is the cap rate for Northgate Business Park?',
      tenantId: TENANT_ID,
    });

    expect(result).toEqual({ kind: 'unresolved', reason: 'unknown' });
    expect(harness.extractedFactModel.find).not.toHaveBeenCalled();
  });

  describe('single', () => {
    it('should answer from the first factIds entry whose loaded amount matches the resolved value, not factIds[0]', async () => {
      const harness = await buildHarness();
      const nonMatching = buildFact({ value: { amount: 5.0, unit: 'percent' } });
      const matching = buildFact({ rawText: '6.25%' });
      const chunk = buildChunk({ documentVersionId: matching.documentVersionId });
      const version = buildVersion({ _id: matching.documentVersionId });

      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'single',
        value: { amount: 6.25, unit: 'percent' },
        factIds: [nonMatching._id.toString(), matching._id.toString()],
        citations: [],
      });
      harness.extractedFactModel.find.mockResolvedValueOnce([nonMatching, matching]);
      harness.evidenceChunkModel.findOne.mockResolvedValueOnce(chunk);
      harness.documentVersionModel.findOne.mockResolvedValueOnce(version);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result.kind).toBe('resolved');
      if (result.kind !== 'resolved') throw new Error('unreachable');
      expect(result.outcome.kind).toBe('answered');
      if (result.outcome.kind !== 'answered') throw new Error('unreachable');
      expect(result.outcome.ledger).toEqual({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        state: 'single',
        factId: matching._id.toString(),
      });
      expect(result.retrievedChunks).toEqual([
        {
          chunkId: matching.chunkId,
          docVersionId: matching.documentVersionId.toString(),
          sha256: SHA256_A,
          text: chunk.text,
          locator: chunk.locator,
          documentId: chunk.documentId.toString(),
        },
      ]);
      expect(harness.extractedFactModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID }),
      );
      expect(harness.evidenceChunkModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID }),
      );
      expect(harness.documentVersionModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID }),
      );
    });

    it('should carry the question-stated period into the ledger provenance', async () => {
      const harness = await buildHarness();
      const fact = buildFact();
      const chunk = buildChunk({ documentVersionId: fact.documentVersionId });
      const version = buildVersion({ _id: fact.documentVersionId });

      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: '2025-Q1',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: '2025-Q1',
        state: 'single',
        value: { amount: 6.25, unit: 'percent' },
        factIds: [fact._id.toString()],
        citations: [],
      });
      harness.extractedFactModel.find.mockResolvedValueOnce([fact]);
      harness.evidenceChunkModel.findOne.mockResolvedValueOnce(chunk);
      harness.documentVersionModel.findOne.mockResolvedValueOnce(version);

      const result = await harness.service.resolve({
        questionText: 'What was the cap rate for Northgate Business Park in Q1 2025?',
        tenantId: TENANT_ID,
      });

      expect(result.kind).toBe('resolved');
      if (result.kind !== 'resolved' || result.outcome.kind !== 'answered') {
        throw new Error('unreachable');
      }
      expect(result.outcome.ledger?.period).toBe('2025-Q1');
    });

    it('should return unresolved when factIds is empty', async () => {
      const harness = await buildHarness();
      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'single',
        value: { amount: 6.25, unit: 'percent' },
        factIds: [],
        citations: [],
      });

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({ kind: 'unresolved', reason: 'representative-fact-not-found' });
      expect(harness.extractedFactModel.find).not.toHaveBeenCalled();
    });

    it('should return unresolved when the representative fact does not load for this tenant', async () => {
      const harness = await buildHarness();
      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'single',
        value: { amount: 6.25, unit: 'percent' },
        factIds: ['missing-fact'],
        citations: [],
      });
      harness.extractedFactModel.find.mockResolvedValueOnce([]);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({ kind: 'unresolved', reason: 'representative-fact-not-found' });
    });

    it("should return unresolved when the fact's chunk does not load for this tenant", async () => {
      const harness = await buildHarness();
      const fact = buildFact();
      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'single',
        value: { amount: 6.25, unit: 'percent' },
        factIds: [fact._id.toString()],
        citations: [],
      });
      harness.extractedFactModel.find.mockResolvedValueOnce([fact]);
      harness.evidenceChunkModel.findOne.mockResolvedValueOnce(null);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({ kind: 'unresolved', reason: 'chunk-not-found' });
      expect(harness.documentVersionModel.findOne).toHaveBeenCalled();
    });

    it("should return unresolved when the fact's document version does not load for this tenant", async () => {
      const harness = await buildHarness();
      const fact = buildFact();
      const chunk = buildChunk({ documentVersionId: fact.documentVersionId });
      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'single',
        value: { amount: 6.25, unit: 'percent' },
        factIds: [fact._id.toString()],
        citations: [],
      });
      harness.extractedFactModel.find.mockResolvedValueOnce([fact]);
      harness.evidenceChunkModel.findOne.mockResolvedValueOnce(chunk);
      harness.documentVersionModel.findOne.mockResolvedValueOnce(null);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({ kind: 'unresolved', reason: 'document-version-not-found' });
    });

    it('should return unresolved when the rendered claim cannot clear its own verification checks', async () => {
      const harness = await buildHarness();
      const fact = buildFact();
      const chunk = buildChunk({ documentVersionId: fact.documentVersionId });
      const version = buildVersion({ _id: fact.documentVersionId });
      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        // A measure slug carrying a digit renders a statement with a second, unexplained numeric
        // token — `buildLedgerClaim`'s own null case.
        measure: 'cap_rate_v2',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate_v2',
        period: 'unstated',
        state: 'single',
        value: { amount: 6.25, unit: 'percent' },
        factIds: [fact._id.toString()],
        citations: [],
      });
      harness.extractedFactModel.find.mockResolvedValueOnce([fact]);
      harness.evidenceChunkModel.findOne.mockResolvedValueOnce(chunk);
      harness.documentVersionModel.findOne.mockResolvedValueOnce(version);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({ kind: 'unresolved', reason: 'ledger-claim-unverifiable' });
    });
  });

  describe('adjudicated', () => {
    it("should answer from the decision's winning fact, carrying the decision and winnerWithdrawn into the ledger provenance", async () => {
      const harness = await buildHarness();
      const winner = buildFact();
      const chunk = buildChunk({ documentVersionId: winner.documentVersionId });
      const version = buildVersion({ _id: winner.documentVersionId });
      const resolvedAt = new Date('2025-04-01T00:00:00.000Z');

      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'adjudicated',
        value: { amount: 6.25, unit: 'percent' },
        factIds: [winner._id.toString(), 'some-other-fact'],
        winnerWithdrawn: true,
        decision: {
          conflictId: 'conflict-1',
          outcome: 'resolved',
          winningFactId: winner._id.toString(),
          decidedBy: 'user-1',
          reason: 'authoritative source',
          resolvedAt,
          ruleFired: 'authority',
          followedProposal: true,
        },
        citations: [],
      });
      harness.extractedFactModel.findOne.mockResolvedValueOnce(winner);
      harness.evidenceChunkModel.findOne.mockResolvedValueOnce(chunk);
      harness.documentVersionModel.findOne.mockResolvedValueOnce(version);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result.kind).toBe('resolved');
      if (result.kind !== 'resolved' || result.outcome.kind !== 'answered') {
        throw new Error('unreachable');
      }
      expect(result.outcome.ledger).toEqual({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        state: 'adjudicated',
        factId: winner._id.toString(),
        winnerWithdrawn: true,
        decision: {
          conflictId: 'conflict-1',
          outcome: 'resolved',
          winningFactId: winner._id.toString(),
          decidedBy: 'user-1',
          reason: 'authoritative source',
          resolvedAt: resolvedAt.toISOString(),
          ruleFired: 'authority',
          followedProposal: true,
        },
      });
      expect(harness.extractedFactModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID }),
      );
    });

    it('should return unresolved when the decision carries no winning fact id', async () => {
      const harness = await buildHarness();
      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'adjudicated',
        value: { amount: 6.25, unit: 'percent' },
        factIds: [],
        decision: { conflictId: 'conflict-1', outcome: 'resolved', resolvedAt: new Date() },
        citations: [],
      });

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({ kind: 'unresolved', reason: 'representative-fact-not-found' });
      expect(harness.extractedFactModel.findOne).not.toHaveBeenCalled();
    });

    it('should return unresolved when the winning fact does not load for this tenant', async () => {
      const harness = await buildHarness();
      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'adjudicated',
        value: { amount: 6.25, unit: 'percent' },
        factIds: ['missing-fact'],
        decision: {
          conflictId: 'conflict-1',
          outcome: 'resolved',
          winningFactId: 'missing-fact',
          resolvedAt: new Date(),
        },
        citations: [],
      });
      harness.extractedFactModel.findOne.mockResolvedValueOnce(null);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({ kind: 'unresolved', reason: 'representative-fact-not-found' });
      expect(harness.evidenceChunkModel.findOne).not.toHaveBeenCalled();
    });

    it('should omit every optional decision field the resolution did not carry', async () => {
      const harness = await buildHarness();
      const winner = buildFact();
      const chunk = buildChunk({ documentVersionId: winner.documentVersionId });
      const version = buildVersion({ _id: winner.documentVersionId });
      const resolvedAt = new Date('2025-04-01T00:00:00.000Z');

      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'adjudicated',
        value: { amount: 6.25, unit: 'percent' },
        factIds: [winner._id.toString()],
        decision: {
          conflictId: 'conflict-1',
          outcome: 'resolved',
          winningFactId: winner._id.toString(),
          resolvedAt,
        },
        citations: [],
      });
      harness.extractedFactModel.findOne.mockResolvedValueOnce(winner);
      harness.evidenceChunkModel.findOne.mockResolvedValueOnce(chunk);
      harness.documentVersionModel.findOne.mockResolvedValueOnce(version);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result.kind).toBe('resolved');
      if (result.kind !== 'resolved' || result.outcome.kind !== 'answered') {
        throw new Error('unreachable');
      }
      expect(result.outcome.ledger?.decision).toEqual({
        conflictId: 'conflict-1',
        outcome: 'resolved',
        winningFactId: winner._id.toString(),
        resolvedAt: resolvedAt.toISOString(),
      });
    });
  });

  describe('conflicted', () => {
    it("should build a conflicting_evidence outcome from the group's facts, carrying the conflict id", async () => {
      const harness = await buildHarness();
      const factA = buildFact({ value: { amount: 5.75, unit: 'percent' }, chunkId: 'chunk-a' });
      const factB = buildFact({ value: { amount: 6.25, unit: 'percent' }, chunkId: 'chunk-b' });

      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'conflicted',
        factIds: [factA._id.toString(), factB._id.toString()],
        conflictId: 'conflict-9',
        citations: [],
      });
      harness.extractedFactModel.find.mockResolvedValueOnce([factA, factB]);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({
        kind: 'resolved',
        outcome: {
          kind: 'conflicting_evidence',
          factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: 'unstated' },
          values: [
            { value: 5.75, unit: 'percent', sourceChunkId: 'chunk-a' },
            { value: 6.25, unit: 'percent', sourceChunkId: 'chunk-b' },
          ],
        },
        retrievedChunks: [],
        conflictIds: ['conflict-9'],
      });
      expect(harness.extractedFactModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID }),
      );
    });

    it('should return unresolved when the group carries no factIds at all', async () => {
      const harness = await buildHarness();
      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'conflicted',
        factIds: [],
        citations: [],
      });

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({ kind: 'unresolved', reason: 'conflicted-with-no-facts' });
      expect(harness.extractedFactModel.find).not.toHaveBeenCalled();
    });

    it('should return unresolved when fewer than two of the conflicted facts load for this tenant', async () => {
      const harness = await buildHarness();
      const factA = buildFact();
      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'conflicted',
        factIds: [factA._id.toString(), 'missing-fact'],
        citations: [],
      });
      harness.extractedFactModel.find.mockResolvedValueOnce([factA]);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result).toEqual({ kind: 'unresolved', reason: 'conflicted-facts-not-found' });
    });

    it('should carry no conflictIds when the group disagrees with no Conflict row yet', async () => {
      const harness = await buildHarness();
      const factA = buildFact({ value: { amount: 5.75, unit: 'percent' } });
      const factB = buildFact({ value: { amount: 6.25, unit: 'percent' } });

      harness.questionResolver.resolve.mockResolvedValueOnce({
        kind: 'resolved',
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
      });
      harness.ledgerService.resolveValue.mockResolvedValueOnce({
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        period: 'unstated',
        state: 'conflicted',
        factIds: [factA._id.toString(), factB._id.toString()],
        citations: [],
      });
      harness.extractedFactModel.find.mockResolvedValueOnce([factA, factB]);

      const result = await harness.service.resolve({
        questionText: 'What is the cap rate for Northgate Business Park?',
        tenantId: TENANT_ID,
      });

      expect(result.kind).toBe('resolved');
      if (result.kind !== 'resolved') throw new Error('unreachable');
      expect(result.conflictIds).toBeUndefined();
    });
  });
});
