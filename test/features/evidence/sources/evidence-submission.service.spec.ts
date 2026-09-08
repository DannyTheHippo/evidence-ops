import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Source } from '../../../../src/database/schemas/evidence/source/source.schema';
import { DocumentsService } from '../../../../src/features/evidence/documents/documents.service';
import {
  ContentTypeMismatchException,
  UnresolvableContentTypeException,
  UnsupportedContentTypeException,
} from '../../../../src/features/evidence/documents/exceptions/documents.exception';
import {
  DEFAULT_MCP_SUBMIT_SOURCE_NAME,
  EvidenceSubmissionService,
  SUBMIT_EVIDENCE_MAX_BASE64_CHARS,
  type SubmitEvidenceInput,
} from '../../../../src/features/evidence/sources/evidence-submission.service';
import {
  InvalidBase64ContentException,
  SubmissionTooLargeException,
  SubmitSourceKindConflictException,
} from '../../../../src/features/evidence/sources/exceptions/sources.exception';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('EvidenceSubmissionService', () => {
  let service: EvidenceSubmissionService;

  const mockSourceModel = getMockModel();
  const mockDocumentsService = { uploadVersion: jest.fn() };
  const mockLogger = getMockLogger();

  const tenantId = 'tenant-a';
  const sourceId = new Types.ObjectId();
  const documentId = new Types.ObjectId();
  const versionId = new Types.ObjectId();

  const pdfBuffer = Buffer.from('%PDF-1.4 fixture bytes');

  const buildMockSource = (overrides: Record<string, unknown> = {}) => ({
    _id: sourceId,
    name: DEFAULT_MCP_SUBMIT_SOURCE_NAME,
    kind: 'mcp-submit',
    tenantId,
    ...overrides,
  });

  const buildInput = (overrides: Partial<SubmitEvidenceInput> = {}): SubmitEvidenceInput => ({
    filename: 'brief.pdf',
    mimeType: 'application/pdf',
    contentBase64: pdfBuffer.toString('base64'),
    tenantId,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceSubmissionService,
        { provide: getModelToken(Source.name), useValue: mockSourceModel },
        { provide: DocumentsService, useValue: mockDocumentsService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<EvidenceSubmissionService>(EvidenceSubmissionService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('refusal classes — every one throws before a source write or an upload', () => {
    const cases: {
      name: string;
      overrides: Partial<SubmitEvidenceInput>;
      expected: new (...args: never[]) => Error;
    }[] = [
      {
        name: 'a base64 payload over the char cap',
        overrides: { contentBase64: 'A'.repeat(SUBMIT_EVIDENCE_MAX_BASE64_CHARS + 4) },
        expected: SubmissionTooLargeException,
      },
      {
        name: 'an illegal base64 charset',
        overrides: { contentBase64: 'ab$c' },
        expected: InvalidBase64ContentException,
      },
      {
        name: 'a length not a multiple of four',
        overrides: { contentBase64: 'abc' },
        expected: InvalidBase64ContentException,
      },
      {
        name: 'padding before the end of the string',
        overrides: { contentBase64: 'ab=c' },
        expected: InvalidBase64ContentException,
      },
      {
        name: 'a data-URL prefix instead of bare base64',
        overrides: { contentBase64: 'data:application/pdf;base64,JVBERi0=' },
        expected: InvalidBase64ContentException,
      },
      {
        name: 'whitespace inside the payload',
        overrides: { contentBase64: 'ab cd' },
        expected: InvalidBase64ContentException,
      },
      {
        name: 'an empty payload that decodes to zero bytes',
        overrides: { contentBase64: '' },
        expected: InvalidBase64ContentException,
      },
      {
        name: 'a MIME type resolveUploadKind does not recognize at all',
        overrides: { mimeType: 'image/png', filename: 'photo.png' },
        expected: UnsupportedContentTypeException,
      },
      {
        name: 'an ambiguous MIME type with a disallowed extension',
        overrides: { mimeType: 'application/vnd.ms-excel', filename: 'legacy.xls' },
        expected: UnresolvableContentTypeException,
      },
      {
        name: 'PDF bytes declared as text/plain',
        overrides: { mimeType: 'text/plain', filename: 'report.txt' },
        expected: ContentTypeMismatchException,
      },
    ];

    it.each(cases)('should refuse $name', async ({ overrides, expected }) => {
      await expect(service.submit(buildInput(overrides))).rejects.toBeInstanceOf(expected);

      expect(mockSourceModel.findOne).not.toHaveBeenCalled();
      expect(mockSourceModel.create).not.toHaveBeenCalled();
      expect(mockDocumentsService.uploadVersion).not.toHaveBeenCalled();
    });
  });

  describe('submission against an existing mcp-submit source', () => {
    it('should upload through the found source and return its identifiers', async () => {
      const mockSource = buildMockSource();
      mockSourceModel.findOne.mockResolvedValueOnce(mockSource);
      mockDocumentsService.uploadVersion.mockResolvedValueOnce({
        document: { _id: documentId },
        currentVersion: { _id: versionId, ingestionStatus: 'pending' },
        isNewVersion: true,
      });

      const result = await service.submit(buildInput());

      expect(mockSourceModel.create).not.toHaveBeenCalled();
      expect(mockDocumentsService.uploadVersion).toHaveBeenCalledWith(
        {
          originalname: 'brief.pdf',
          mimetype: 'application/pdf',
          size: pdfBuffer.length,
          buffer: pdfBuffer,
        },
        {},
        tenantId,
        { sourceId: mockSource._id, path: 'brief.pdf' },
      );
      expect(result).toEqual({
        documentId: documentId.toString(),
        documentVersionId: versionId.toString(),
        sha256: expect.any(String) as string,
        ingestionStatus: 'pending',
        isNewVersion: true,
        sourceId: sourceId.toString(),
      });
    });

    it('should trim an untrimmed source label before looking it up', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource({ name: 'My Label' }));
      mockDocumentsService.uploadVersion.mockResolvedValueOnce({
        document: { _id: documentId },
        currentVersion: { _id: versionId, ingestionStatus: 'pending' },
        isNewVersion: true,
      });

      await service.submit(buildInput({ sourceLabel: '  My Label  ' }));

      expect(mockSourceModel.findOne).toHaveBeenCalledWith({ tenantId, name: 'My Label' });
    });

    it('should look up the default source name when no label is given', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource());
      mockDocumentsService.uploadVersion.mockResolvedValueOnce({
        document: { _id: documentId },
        currentVersion: { _id: versionId, ingestionStatus: 'pending' },
        isNewVersion: true,
      });

      await service.submit(buildInput());

      expect(mockSourceModel.findOne).toHaveBeenCalledWith({
        tenantId,
        name: DEFAULT_MCP_SUBMIT_SOURCE_NAME,
      });
    });

    it('should refuse with a 409 when the found row is not an mcp-submit source, without uploading', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource({ kind: 'local-folder' }));

      await expect(service.submit(buildInput())).rejects.toBeInstanceOf(
        SubmitSourceKindConflictException,
      );
      expect(mockDocumentsService.uploadVersion).not.toHaveBeenCalled();
    });
  });

  describe('submission with no existing source row', () => {
    it('should create an untracked mcp-submit source and upload through it', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);
      const created = buildMockSource();
      mockSourceModel.create.mockResolvedValueOnce(created);
      mockDocumentsService.uploadVersion.mockResolvedValueOnce({
        document: { _id: documentId },
        currentVersion: { _id: versionId, ingestionStatus: 'pending' },
        isNewVersion: true,
      });

      await service.submit(buildInput());

      expect(mockSourceModel.create).toHaveBeenCalledWith({
        name: DEFAULT_MCP_SUBMIT_SOURCE_NAME,
        kind: 'mcp-submit',
        path: DEFAULT_MCP_SUBMIT_SOURCE_NAME,
        enabled: true,
        tracked: false,
        connectivity: 'manual',
        reachability: 'live',
        sourceClass: 'unclassified',
        tenantId,
      });
    });

    it('should re-resolve a duplicate-key create race against the row that won it', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);
      mockSourceModel.create.mockRejectedValueOnce({ code: 11000 });
      const raced = buildMockSource();
      mockSourceModel.findOne.mockResolvedValueOnce(raced);
      mockDocumentsService.uploadVersion.mockResolvedValueOnce({
        document: { _id: documentId },
        currentVersion: { _id: versionId, ingestionStatus: 'pending' },
        isNewVersion: false,
      });

      const result = await service.submit(buildInput());

      expect(result.sourceId).toBe(sourceId.toString());
      expect(mockDocumentsService.uploadVersion).toHaveBeenCalled();
    });

    it('should refuse with a 409 when the race winner is not an mcp-submit source', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);
      mockSourceModel.create.mockRejectedValueOnce({ code: 11000 });
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource({ kind: 'local-folder' }));

      await expect(service.submit(buildInput())).rejects.toBeInstanceOf(
        SubmitSourceKindConflictException,
      );
      expect(mockDocumentsService.uploadVersion).not.toHaveBeenCalled();
    });

    it('should rethrow the original duplicate-key error when the race re-lookup finds nothing', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);
      const raceError = { code: 11000 };
      mockSourceModel.create.mockRejectedValueOnce(raceError);
      mockSourceModel.findOne.mockResolvedValueOnce(null);

      await expect(service.submit(buildInput())).rejects.toBe(raceError);
      expect(mockDocumentsService.uploadVersion).not.toHaveBeenCalled();
    });

    it('should rethrow a non-duplicate object error from create unchanged', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);
      const error = { code: 500, message: 'boom' };
      mockSourceModel.create.mockRejectedValueOnce(error);

      await expect(service.submit(buildInput())).rejects.toBe(error);
      expect(mockDocumentsService.uploadVersion).not.toHaveBeenCalled();
    });

    it('should rethrow a plain Error from create unchanged (no code property at all)', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);
      const error = new Error('boom');
      mockSourceModel.create.mockRejectedValueOnce(error);

      await expect(service.submit(buildInput())).rejects.toBe(error);
    });

    it('should rethrow a non-object thrown value from create unchanged', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);
      mockSourceModel.create.mockRejectedValueOnce('boom');

      await expect(service.submit(buildInput())).rejects.toBe('boom');
    });

    it('should rethrow a null thrown value from create unchanged', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);
      mockSourceModel.create.mockRejectedValueOnce(null);

      await expect(service.submit(buildInput())).rejects.toBe(null);
    });
  });
});
