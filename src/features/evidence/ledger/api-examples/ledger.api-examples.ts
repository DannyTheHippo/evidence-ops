import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { FactListResponseDto } from '../dtos/response/fact-list.response.dto';
import { LedgerCellListResponseDto } from '../dtos/response/ledger-cell-list.response.dto';
import { LedgerEntityListResponseDto } from '../dtos/response/ledger-entity-list.response.dto';
import { LedgerResolutionResponseDto } from '../dtos/response/ledger-resolution.response.dto';

const exampleCitation = {
  factId: '65f1c2e4a1b2c3d4e5f6a7b8',
  documentId: '65f1c2e4a1b2c3d4e5f6a7c0',
  documentVersionId: '65f1c2e4a1b2c3d4e5f6a7c1',
  sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  locator: { kind: 'xlsx-cell', sheet: 'Comps', cell: 'D4' },
  extractorVersion: 'xlsx-1',
  quote: '5.25%',
  withdrawn: false,
};

const exampleSingleCell = {
  entity: 'Northgate Business Park',
  measure: 'cap_rate',
  period: '2025-Q1',
  state: 'single',
  value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
  factIds: ['65f1c2e4a1b2c3d4e5f6a7b8'],
};

const exampleAdjudicatedCell = {
  entity: 'Cedar Bluff Logistics',
  measure: 'net_operating_income',
  period: '2025',
  state: 'adjudicated',
  value: { amount: 2134450, unit: 'usd', canonicalAmount: 2134450 },
  factIds: ['65f1c2e4a1b2c3d4e5f6a7d1', '65f1c2e4a1b2c3d4e5f6a7d2'],
  conflictId: '65f1c2e4a1b2c3d4e5f6a7e0',
  decision: {
    conflictId: '65f1c2e4a1b2c3d4e5f6a7e0',
    outcome: 'resolved',
    winningFactId: '65f1c2e4a1b2c3d4e5f6a7d1',
    decidedBy: '65f1c2e4a1b2c3d4e5f6a7c9',
    reason: 'The audited statement supersedes the broker summary.',
    resolvedAt: '2026-07-04T09:15:00.000Z',
    ruleFired: 'authority',
    followedProposal: true,
  },
  winnerWithdrawn: false,
};

export const ledgerApiExamples: Record<string, ApiResponseOptions> = {
  cells: {
    status: HttpStatus.OK,
    description:
      "The tenant's ledger cells, one per entity × measure × period, each resolved to a state.",
    type: LedgerCellListResponseDto,
    examples: {
      example: {
        summary: 'A settled cell and an adjudicated one',
        value: { docs: [exampleSingleCell, exampleAdjudicatedCell], count: 2 },
      },
    },
  },
  resolution: {
    status: HttpStatus.OK,
    description: 'One cell resolved in full, with the citations the resolution rests on.',
    type: LedgerResolutionResponseDto,
    examples: {
      example: {
        summary: 'A single agreed value with its citation',
        value: { ...exampleSingleCell, citations: [exampleCitation] },
      },
    },
  },
  facts: {
    status: HttpStatus.OK,
    description:
      'Every fact behind one cell, at any measure status — the drill-down deliberately shows proposed-measure facts that the cell view excludes.',
    type: FactListResponseDto,
    examples: {
      example: {
        summary: 'One confirmed fact behind a cell',
        value: {
          docs: [
            {
              id: '65f1c2e4a1b2c3d4e5f6a7b8',
              factKey: {
                entity: 'Northgate Business Park',
                metric: 'cap_rate',
                period: '2025-Q1',
              },
              value: { amount: 5.25, unit: 'percent' },
              canonicalAmount: 0.0525,
              rawText: '5.25%',
              confidence: 0.95,
              extractionMethod: 'regex',
              measureId: '65f1c2e4a1b2c3d4e5f6a7a1',
              measureVersion: 1,
              measureStatus: 'confirmed',
              periodStart: '2025-01-01T00:00:00.000Z',
              periodEnd: '2025-03-31T00:00:00.000Z',
              entityMatched: true,
              citation: exampleCitation,
              withdrawn: false,
              superseded: false,
              createdAt: '2026-07-01T00:00:00.000Z',
            },
          ],
          count: 1,
        },
      },
    },
  },
  entities: {
    status: HttpStatus.OK,
    description: 'Entities the ledger holds confirmed facts for.',
    type: LedgerEntityListResponseDto,
    examples: {
      example: {
        summary: 'Two entities',
        value: {
          docs: [
            { entity: 'Cedar Bluff Logistics', factCount: 8, measureCount: 3 },
            { entity: 'Northgate Business Park', factCount: 12, measureCount: 4 },
          ],
          count: 2,
        },
      },
    },
  },
  measureNotFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'No measure with that slug exists for the tenant, or it has been rejected.',
    examples: {
      example: {
        summary: 'Unknown measure',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Measure 'occupancy' not found",
          error: 'Not Found',
        },
      },
    },
  },
};
