import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { buildMultipartEmail } from '../../../../scripts/fixtures/adversarial/lib/build-email-fixtures';
import type { DocumentVersionDocument } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import {
  extractXlsxFacts,
  type XlsxExtractionContext,
} from '../../../../src/features/evidence/facts/xlsx-fact-extractor';
import {
  resolveUploadKind,
  SOURCE_KIND_TO_MIME_TYPE,
} from '../../../../src/features/evidence/documents/documents.constant';
import { DocumentsService } from '../../../../src/features/evidence/documents/documents.service';
import { EmailAttachmentService } from '../../../../src/features/evidence/ingestion/email-attachment.service';
import { buildDocumentParsers } from '../../../../src/features/evidence/ingestion/ingestion.module';
import { ParserRegistry } from '../../../../src/features/evidence/ingestion/parser.registry';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

const COMPS_FIXTURE = path.join(__dirname, '../../../../fixtures/data-room/comps.xlsx');
const XLSX_MIME = SOURCE_KIND_TO_MIME_TYPE.xlsx;

/**
 * The step's acceptance case, executed rather than reasoned about: an `.eml` carrying a spreadsheet
 * produces two documents, and a fact derived from the attachment cites a cell.
 *
 * The claim under test is that provenance does not degrade because a spreadsheet arrived by email.
 * So the assertions are comparative, not merely structural: the attachment is driven through the
 * SAME registry, the SAME parser and the SAME fact extractor as a direct upload of the identical
 * workbook, and the two are required to agree element-for-element and fact-for-fact. A locator that
 * merely happened to be an `xlsx-cell` would satisfy a shape check while still having drifted.
 */
describe('email attachment acceptance — an XLSX that arrived by email', () => {
  const versionId = new Types.ObjectId();
  const documentId = new Types.ObjectId();
  const version = {
    _id: versionId,
    documentId,
    tenantId: 'tenant-a',
  } as unknown as DocumentVersionDocument;

  const registry = new ParserRegistry(buildDocumentParsers());

  let service: EmailAttachmentService;
  const mockDocumentModel = getMockModel();
  const mockDocumentsService = { upload: jest.fn() };

  const emailCarrying = async (): Promise<{ email: Buffer; workbook: Buffer }> => {
    const workbook = await readFile(COMPS_FIXTURE);
    return {
      workbook,
      email: buildMultipartEmail('Q3 comps', 'The comps extract is attached.', [
        { filename: 'comps.xlsx', mimeType: XLSX_MIME, content: workbook },
      ]),
    };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailAttachmentService,
        { provide: getModelToken(Document.name), useValue: mockDocumentModel },
        { provide: DocumentsService, useValue: mockDocumentsService },
        { provide: AppLogger, useValue: getMockLogger() },
      ],
    }).compile();
    service = module.get<EmailAttachmentService>(EmailAttachmentService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('produces a second document for the attachment, alongside the email document itself', async () => {
    const { email } = await emailCarrying();
    mockDocumentModel.findOne.mockResolvedValueOnce(null);

    const result = await service.unwrapAttachments(version, email);

    // Document one is the `.eml` itself, already created by the upload that started this ingest —
    // `version` above IS its current version. Document two is this call's own creation.
    expect(result.created).toBe(1);
    expect(mockDocumentsService.upload).toHaveBeenCalledTimes(1);

    const [file, , tenantId, source] = mockDocumentsService.upload.mock.calls[0] as [
      { originalname: string; mimetype: string; buffer: Buffer },
      unknown,
      string,
      { emailOrigin: { parentVersionId: Types.ObjectId; partIndex: number } },
    ];
    expect(tenantId).toBe('tenant-a');
    // The attachment document points back at the email it came out of, so the origin survives the
    // unwrapping instead of being flattened away.
    expect(source.emailOrigin.parentVersionId).toBe(versionId);
    expect(source.emailOrigin.partIndex).toBe(0);
    // Resolved by the ordinary gate, from what the message declared — the same call a browser
    // upload of this file makes.
    expect(resolveUploadKind(file.mimetype, file.originalname)).toBe('xlsx');
  });

  it('cites xlsx-cell for a fact from the attachment, identically to a direct upload of the same workbook', async () => {
    const { email, workbook } = await emailCarrying();
    mockDocumentModel.findOne.mockResolvedValueOnce(null);

    await service.unwrapAttachments(version, email);
    const [file] = mockDocumentsService.upload.mock.calls[0] as [{ buffer: Buffer }];

    // Dispatched through the registry by the canonical MIME the gate resolved, exactly as
    // `IngestionService` dispatches an uploaded version — not by reaching for `XlsxParser` directly.
    const parser = registry.resolve(XLSX_MIME);
    const viaEmail = await parser.parse(file.buffer);
    const viaUpload = await parser.parse(workbook);

    expect(viaEmail.extractorVersion).toBe(viaUpload.extractorVersion);
    expect(viaEmail.elements).toEqual(viaUpload.elements);

    // The extractor's own allowlist context, standing in for a tenant whose confirmed measures are
    // exactly the seed ontology — this spec compares two parses of the same workbook, not
    // header-proposal behaviour, so `proposeFromHeaders` stays off.
    const context: XlsxExtractionContext = {
      matchable: METRIC_ONTOLOGY,
      rejectedSlugs: new Set(),
      proposeFromHeaders: false,
    };
    const emailFacts = extractXlsxFacts(viaEmail.elements, context);
    const uploadFacts = extractXlsxFacts(viaUpload.elements, context);

    expect(emailFacts.accepted.length).toBeGreaterThan(0);
    expect(emailFacts.accepted.every((fact) => fact.locator.kind === 'xlsx-cell')).toBe(true);
    // A cell address, not just the kind: the coordinate a citation resolves against has to be the
    // same coordinate, or the locator kind surviving means nothing.
    const cited = emailFacts.accepted[0].locator;
    expect(cited.kind === 'xlsx-cell' && cited.cell).toMatch(/^[A-Z]+\d+$/);
    expect(emailFacts.accepted).toEqual(uploadFacts.accepted);
  });
});
