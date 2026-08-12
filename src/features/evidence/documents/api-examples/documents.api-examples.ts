import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { DocumentResponseDto } from '../dtos/response/document.response.dto';
import { DocumentWithVersionsResponseDto } from '../dtos/response/document-with-versions.response.dto';

const exampleVersion = {
  id: '65f1c2e4a1b2c3d4e5f6a7b9',
  versionNumber: 1,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85',
  sizeBytes: 245760,
  createdAt: '2026-07-01T00:00:00.000Z',
};

const exampleDocument = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  title: 'Q3 Rent Roll',
  sourceKind: 'xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  currentVersion: exampleVersion,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const documentsApiExamples: Record<string, ApiResponseOptions> = {
  uploaded: {
    status: HttpStatus.CREATED,
    description:
      'Document uploaded. Unchanged bytes for an existing document return the existing version.',
    type: DocumentResponseDto,
    examples: {
      example: {
        summary: 'Uploaded document with its current version',
        value: exampleDocument,
      },
    },
  },
  unsupportedType: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    description: 'Content type is not one of pdf, docx, xlsx.',
    examples: {
      example: {
        summary: 'Disallowed content type',
        value: {
          statusCode: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
          message: "Unsupported content type 'text/csv'; expected one of pdf, docx, xlsx",
          error: 'Unsupported Media Type',
        },
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'Document does not exist.',
    examples: {
      example: {
        summary: 'Unknown document',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Document '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  list: {
    status: HttpStatus.OK,
    description: 'Paginated list of documents with their current version.',
    examples: {
      example: {
        summary: 'One document',
        value: { docs: [exampleDocument], count: 1 },
      },
    },
  },
  detail: {
    status: HttpStatus.OK,
    description: 'Document with its full version history.',
    type: DocumentWithVersionsResponseDto,
    examples: {
      example: {
        summary: 'Document with one version',
        value: { ...exampleDocument, versions: [exampleVersion] },
      },
    },
  },
  versionContent: {
    status: HttpStatus.OK,
    description:
      'Raw bytes of the stored document version, served as a file download with a sanitized filename.',
  },
  versionContentNotFound: {
    status: HttpStatus.NOT_FOUND,
    description:
      'Document version does not exist, belongs to another tenant, or its stored bytes carry a different tenant stamp — all three are indistinguishable from each other.',
    examples: {
      example: {
        summary: 'Unknown or cross-tenant version',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Document version '65f1c2e4a1b2c3d4e5f6a7b9' not found",
          error: 'Not Found',
        },
      },
    },
  },
};
