import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import type { DocumentDocument } from '../../../../src/database/schemas/evidence/document/document.schema';
import type { DocumentVersionDocument } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import type { ExtractedFactDocument } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { loadFactLifecycle } from '../../../../src/features/evidence/ledger/load-fact-lifecycle';
import { getMockModel } from '../../../utils/get-mock-model';

describe('loadFactLifecycle', () => {
  const tenantId = 'acme-corp';
  const mockDocumentVersionModel = getMockModel();
  const mockDocumentModel = getMockModel();

  afterEach(() => jest.resetAllMocks());

  function versionModel() {
    return mockDocumentVersionModel as unknown as Model<DocumentVersionDocument>;
  }

  function documentModel() {
    return mockDocumentModel as unknown as Model<DocumentDocument>;
  }

  it('should run no query at all for an empty fact list', async () => {
    const result = await loadFactLifecycle(versionModel(), documentModel(), [], tenantId);

    expect(result).toEqual(new Map());
    expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
    expect(mockDocumentModel.find).not.toHaveBeenCalled();
  });

  it('should run exactly two queries regardless of how many facts are passed', async () => {
    const documentId = new Types.ObjectId();
    const versionId = new Types.ObjectId();
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, documentId, sha256: 'sha-a', withdrawnAt: undefined },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([
      { _id: documentId, currentVersionId: versionId },
    ]);

    const facts = [
      { _id: new Types.ObjectId(), documentVersionId: versionId },
      { _id: new Types.ObjectId(), documentVersionId: versionId },
      { _id: new Types.ObjectId(), documentVersionId: versionId },
      { _id: new Types.ObjectId(), documentVersionId: versionId },
      { _id: new Types.ObjectId(), documentVersionId: versionId },
    ] as Pick<ExtractedFactDocument, '_id' | 'documentVersionId'>[];

    const result = await loadFactLifecycle(versionModel(), documentModel(), facts, tenantId);

    expect(mockDocumentVersionModel.find).toHaveBeenCalledTimes(1);
    expect(mockDocumentModel.find).toHaveBeenCalledTimes(1);
    expect(mockDocumentVersionModel.find).toHaveBeenCalledWith(
      { _id: { $in: [versionId] }, tenantId },
      { documentId: 1, sha256: 1, withdrawnAt: 1 },
    );
    expect(mockDocumentModel.find).toHaveBeenCalledWith(
      { _id: { $in: [documentId] }, tenantId },
      { currentVersionId: 1 },
    );
    expect(result.size).toBe(5);
  });

  it('should flag withdrawn and superseded independently, off the version and document rows', async () => {
    const documentId = new Types.ObjectId();
    const currentVersionId = new Types.ObjectId();
    const priorVersionId = new Types.ObjectId();
    const currentFactId = new Types.ObjectId();
    const priorFactId = new Types.ObjectId();
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: currentVersionId, documentId, sha256: 'sha-current', withdrawnAt: undefined },
      { _id: priorVersionId, documentId, sha256: 'sha-prior', withdrawnAt: new Date('2025-01-01') },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([{ _id: documentId, currentVersionId }]);

    const facts = [
      { _id: currentFactId, documentVersionId: currentVersionId },
      { _id: priorFactId, documentVersionId: priorVersionId },
    ] as Pick<ExtractedFactDocument, '_id' | 'documentVersionId'>[];

    const result = await loadFactLifecycle(versionModel(), documentModel(), facts, tenantId);

    expect(result.get(currentFactId.toString())).toEqual({
      withdrawn: false,
      superseded: false,
      sha256: 'sha-current',
      documentId: documentId.toString(),
    });
    expect(result.get(priorFactId.toString())).toEqual({
      withdrawn: true,
      superseded: true,
      sha256: 'sha-prior',
      documentId: documentId.toString(),
    });
  });

  it('should map a fact whose documentVersionId does not resolve to undefined, never dropping the entry', async () => {
    mockDocumentVersionModel.find.mockResolvedValueOnce([]);
    mockDocumentModel.find.mockResolvedValueOnce([]);
    const factId = new Types.ObjectId();

    const result = await loadFactLifecycle(
      versionModel(),
      documentModel(),
      [{ _id: factId, documentVersionId: new Types.ObjectId() }],
      tenantId,
    );

    expect(result.has(factId.toString())).toBe(true);
    expect(result.get(factId.toString())).toBeUndefined();
  });

  it('should treat a version whose document row no longer resolves as not superseded, keeping its sha256', async () => {
    const documentId = new Types.ObjectId();
    const versionId = new Types.ObjectId();
    const factId = new Types.ObjectId();
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, documentId, sha256: 'sha-orphaned', withdrawnAt: undefined },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([]);

    const result = await loadFactLifecycle(
      versionModel(),
      documentModel(),
      [{ _id: factId, documentVersionId: versionId }],
      tenantId,
    );

    expect(result.get(factId.toString())).toEqual({
      withdrawn: false,
      superseded: false,
      sha256: 'sha-orphaned',
      documentId: documentId.toString(),
    });
  });

  it('should not query Document at all when no fact’s version resolves', async () => {
    mockDocumentVersionModel.find.mockResolvedValueOnce([]);

    await loadFactLifecycle(
      versionModel(),
      documentModel(),
      [{ _id: new Types.ObjectId(), documentVersionId: new Types.ObjectId() }],
      tenantId,
    );

    expect(mockDocumentModel.find).not.toHaveBeenCalled();
  });
});
