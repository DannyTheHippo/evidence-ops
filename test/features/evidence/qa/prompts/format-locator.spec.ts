import type { EvidenceLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { formatLocator } from '../../../../../src/features/evidence/qa/prompts/format-locator';

describe('formatLocator', () => {
  it('should format a pdf-page locator', () => {
    const locator: EvidenceLocator = { kind: 'pdf-page', page: 3, extractorVersion: 'v1' };

    expect(formatLocator(locator)).toBe('PDF page 3');
  });

  it('should format a docx-paragraph locator with a heading path', () => {
    const locator: EvidenceLocator = {
      kind: 'docx-paragraph',
      paragraphIndex: 5,
      headingPath: ['Executive Summary', 'Overview'],
      extractorVersion: 'v1',
    };

    expect(formatLocator(locator)).toBe('DOCX paragraph 5 (Executive Summary > Overview)');
  });

  it('should format a docx-paragraph locator without a heading path', () => {
    const locator: EvidenceLocator = {
      kind: 'docx-paragraph',
      paragraphIndex: 5,
      headingPath: [],
      extractorVersion: 'v1',
    };

    expect(formatLocator(locator)).toBe('DOCX paragraph 5');
  });

  it('should format an xlsx-region locator', () => {
    const locator: EvidenceLocator = {
      kind: 'xlsx-region',
      sheetName: 'Rent Roll',
      range: 'A1:C10',
      extractorVersion: 'v1',
    };

    expect(formatLocator(locator)).toBe("XLSX sheet 'Rent Roll' range A1:C10");
  });

  it('should format an xlsx-cell locator', () => {
    const locator: EvidenceLocator = {
      kind: 'xlsx-cell',
      sheetName: 'Rent Roll',
      cell: 'B7',
      extractorVersion: 'v1',
    };

    expect(formatLocator(locator)).toBe("XLSX sheet 'Rent Roll' cell B7");
  });

  it('should format a text-block locator with a heading path', () => {
    const locator: EvidenceLocator = {
      kind: 'text-block',
      blockIndex: 2,
      headingPath: ['Overview'],
      extractorVersion: 'v1',
    };

    expect(formatLocator(locator)).toBe('Text block 2 (Overview)');
  });

  it('should format a text-block locator with an empty heading path', () => {
    const locator: EvidenceLocator = {
      kind: 'text-block',
      blockIndex: 0,
      headingPath: [],
      extractorVersion: 'v1',
    };

    expect(formatLocator(locator)).toBe('Text block 0 ()');
  });

  it('should format a pptx-slide locator', () => {
    const locator: EvidenceLocator = { kind: 'pptx-slide', slide: 4, extractorVersion: 'v1' };

    expect(formatLocator(locator)).toBe('PPTX slide 4');
  });
});
