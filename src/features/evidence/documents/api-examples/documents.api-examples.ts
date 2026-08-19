import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { DocumentResponseDto } from '../dtos/response/document.response.dto';
import { DocumentWithVersionsResponseDto } from '../dtos/response/document-with-versions.response.dto';
import { EvidenceChunkResponseDto } from '../dtos/response/evidence-chunk.response.dto';

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
  sourceClass: 'unclassified',
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
  stream: {
    status: HttpStatus.OK,
    description:
      'text/event-stream. Polls every 3s. `documents` events carry the exact shape GET /documents ' +
      'returns; a `heartbeat` event fires every 15s; a terminal `error` event means the client ' +
      'should fall back to polling GET /documents. Re-checks the connecting session every 30s and ' +
      'closes if it is gone or moved tenants, and closes unconditionally once the connection has ' +
      "been open for the configured max stream lifetime — this stream's own list has no terminal " +
      'state of its own, unlike the answer/run streams.',
  },
  streamConnectionLimitExceeded: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: "The caller's tenant or user is already at its open-SSE-stream cap.",
    examples: {
      example: {
        summary: 'Open-stream cap reached',
        value: {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: "User 'user-1' is at its open-stream limit (10)",
          error: 'Too Many Requests',
        },
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
  versionChunks: {
    status: HttpStatus.OK,
    description:
      "The version's evidence chunks, in locator order. Not a re-parse of the source document — " +
      'chunk granularity may span pages, ~12% overlap means adjacent chunks repeat some text, and ' +
      'elements quarantined at ingestion are absent entirely.',
    type: EvidenceChunkResponseDto,
    examples: {
      example: {
        summary: 'Two chunks of one version',
        value: {
          docs: [
            {
              id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
              text: 'The cap rate for Northgate Business Park is approximately 6.10%.',
              tokenCount: 128,
              locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
            },
          ],
          count: 1,
        },
      },
    },
  },
  versionChunksNotFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'Document version does not exist or belongs to another tenant.',
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
  deleted: {
    status: HttpStatus.NO_CONTENT,
    description:
      'Document deleted along with its versions, stored bytes, evidence chunks, and extracted ' +
      'facts. Conflicts referencing a deleted fact are resolved as superseded, not deleted.',
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description: 'Caller does not hold the admin role required to delete a document.',
    examples: {
      example: {
        summary: 'Insufficient role',
        value: {
          statusCode: HttpStatus.FORBIDDEN,
          message: 'Insufficient role for this action',
          error: 'Forbidden',
        },
      },
    },
  },
};
