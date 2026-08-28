import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { buildMultipartEmail } from '../../../../scripts/fixtures/adversarial/lib/build-email-fixtures';
import type { DocumentVersionDocument } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import { DocumentsService } from '../../../../src/features/evidence/documents/documents.service';
import { EmailAttachmentService } from '../../../../src/features/evidence/ingestion/email-attachment.service';
import {
  HostileEmailException,
  MalformedEmailException,
} from '../../../../src/features/evidence/ingestion/exceptions/ingestion.exception';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger, type MockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('EmailAttachmentService', () => {
  let service: EmailAttachmentService;
  let mockLogger: MockLogger;

  const mockDocumentModel = getMockModel();
  const mockDocumentsService = { upload: jest.fn() };

  const versionId = new Types.ObjectId();
  const documentId = new Types.ObjectId();

  const version = {
    _id: versionId,
    documentId,
    tenantId: 'tenant-a',
  } as unknown as DocumentVersionDocument;

  const csvAttachmentEmail = (): Buffer =>
    buildMultipartEmail('Suite export', 'Body text.', [
      {
        filename: 'suite-export.csv',
        mimeType: 'text/csv',
        content: Buffer.from('a,b\r\n1,2\r\n'),
      },
    ]);

  beforeEach(async () => {
    mockLogger = getMockLogger();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailAttachmentService,
        { provide: getModelToken(Document.name), useValue: mockDocumentModel },
        { provide: DocumentsService, useValue: mockDocumentsService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<EmailAttachmentService>(EmailAttachmentService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should create one document per attachment, stamped with the message it came out of', async () => {
    mockDocumentModel.findOne.mockResolvedValueOnce(null);

    const result = await service.unwrapAttachments(version, csvAttachmentEmail());

    expect(result).toEqual({ created: 1, skippedReasons: [] });
    expect(mockDocumentsService.upload).toHaveBeenCalledTimes(1);
    const [file, dto, tenantId, source] = mockDocumentsService.upload.mock.calls[0] as [
      { originalname: string; mimetype: string; size: number; buffer: Buffer },
      { title: string },
      string,
      { emailOrigin: Record<string, unknown> },
    ];
    expect(file.originalname).toBe('suite-export.csv');
    expect(file.mimetype).toBe('text/csv');
    expect(file.size).toBe(file.buffer.length);
    expect(dto).toEqual({ title: 'suite-export.csv' });
    expect(tenantId).toBe('tenant-a');
    expect(source.emailOrigin).toEqual({
      parentVersionId: versionId,
      parentDocumentId: documentId,
      partIndex: 0,
      attachmentFilename: 'suite-export.csv',
      messageId: 'kestrel-point-q3-2026@meridian-facilities.example',
      from: expect.stringContaining('dana.okonkwo@meridian-facilities.example') as unknown,
      sentAt: new Date('2026-08-04T09:14:00.000Z'),
    });
    // Nothing was skipped, so nothing is reported as skipped.
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  it('should skip, with a recorded reason, an attachment of a format no parser claims', async () => {
    const email = buildMultipartEmail('Signature', 'Body text.', [
      { filename: 'logo.png', mimeType: 'image/png', content: Buffer.from([0x89, 0x50]) },
    ]);

    const result = await service.unwrapAttachments(version, email);

    expect(result.created).toBe(0);
    expect(result.skippedReasons).toEqual([expect.stringContaining('logo.png')]);
    expect(mockDocumentsService.upload).not.toHaveBeenCalled();
    expect(mockDocumentModel.findOne).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  it('should refuse the whole message when an attachment declares one format and carries another', async () => {
    // The identity gate, called through the exact functions a direct upload of the same bytes
    // faces: an attachment is not trusted because the message vouched for it.
    const email = buildMultipartEmail('Q3 ledger', 'Body text.', [
      {
        filename: 'ledger.xlsx',
        mimeType: XLSX_MIME,
        content: Buffer.from('%PDF-1.4 these are not zip bytes'),
      },
    ]);

    await expect(service.unwrapAttachments(version, email)).rejects.toBeInstanceOf(
      HostileEmailException,
    );
    expect(mockDocumentsService.upload).not.toHaveBeenCalled();
  });

  it('should reuse an attachment an earlier attempt already unwrapped instead of duplicating it', async () => {
    // Ingest activities are at-least-once, so a second attempt over the same version walks the
    // same parts in the same order and must find, not re-create.
    mockDocumentModel.findOne.mockResolvedValueOnce({ _id: new Types.ObjectId() });

    const result = await service.unwrapAttachments(version, csvAttachmentEmail());

    expect(result.created).toBe(0);
    expect(mockDocumentsService.upload).not.toHaveBeenCalled();
    expect(mockDocumentModel.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      'emailOrigin.parentVersionId': versionId,
      'emailOrigin.partIndex': 0,
    });
  });

  it('should carry the parser-level skip reasons through alongside its own', async () => {
    const email = Buffer.from(
      [
        'From: a@b.example',
        'Content-Type: multipart/alternative; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/html; charset="utf-8"',
        '',
        '<p>hi</p>',
        '--b1--',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const result = await service.unwrapAttachments(version, email);

    expect(result).toEqual({
      created: 0,
      skippedReasons: [expect.stringContaining('text/html')],
    });
  });

  it('should let a malformed message refuse rather than reporting an email with nothing in it', async () => {
    await expect(
      service.unwrapAttachments(version, Buffer.from('not a message at all', 'utf8')),
    ).rejects.toBeInstanceOf(MalformedEmailException);
  });
});
