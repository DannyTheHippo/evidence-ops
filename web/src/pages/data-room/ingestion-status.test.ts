import { describe, expect, it } from 'vitest';
import type { DocumentSourceClass, DocumentVersionIngestionStatus } from '../../api/client';
import { INGESTION_LABEL, INGESTION_TONE, SOURCE_CLASS_LABEL } from './ingestion-status';

const INGESTION_STATUSES: DocumentVersionIngestionStatus[] = [
  'pending',
  'completed',
  'failed',
  'needs-ocr',
  'facts-failed',
];

const SOURCE_CLASSES: DocumentSourceClass[] = [
  'crm-export',
  'pm-export',
  'spreadsheet',
  'memo',
  'report',
  'unclassified',
];

describe('INGESTION_TONE', () => {
  it('is total over every ingestion status', () => {
    for (const status of INGESTION_STATUSES) {
      expect(INGESTION_TONE[status]).toBeDefined();
    }
  });

  it('renders pending as info, matching the upload queue in-progress tone', () => {
    expect(INGESTION_TONE.pending).toBe('info');
  });
});

describe('INGESTION_LABEL', () => {
  it('is total over every ingestion status', () => {
    for (const status of INGESTION_STATUSES) {
      expect(INGESTION_LABEL[status]).toBeDefined();
    }
  });
});

describe('SOURCE_CLASS_LABEL', () => {
  it('is total over every source class, including unclassified', () => {
    for (const sourceClass of SOURCE_CLASSES) {
      expect(SOURCE_CLASS_LABEL[sourceClass]).toBeDefined();
    }
    expect(SOURCE_CLASS_LABEL.unclassified).toBe('Unclassified');
  });
});
