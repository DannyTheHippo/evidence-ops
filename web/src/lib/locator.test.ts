import { describe, expect, it } from 'vitest';
import type { Locator } from '../api/client';
import { formatLocator, locatorGroupKey, locatorGroupLabel, pdfPageOf } from './locator';

describe('formatLocator', () => {
  it('should format a pdf-page locator', () => {
    const locator: Locator = { kind: 'pdf-page', extractorVersion: 'v1', page: 3 };

    expect(formatLocator(locator)).toBe('p.3');
  });

  it('should format an xlsx-cell locator', () => {
    const locator: Locator = {
      kind: 'xlsx-cell',
      extractorVersion: 'v1',
      sheetName: 'Comps',
      cell: 'F2',
    };

    expect(formatLocator(locator)).toBe('Comps!F2');
  });

  it('should format an xlsx-region locator', () => {
    const locator: Locator = {
      kind: 'xlsx-region',
      extractorVersion: 'v1',
      sheetName: 'Comps',
      range: 'A1:C10',
    };

    expect(formatLocator(locator)).toBe('Comps!A1:C10');
  });

  it('should format a docx-paragraph locator with a heading path', () => {
    const locator: Locator = {
      kind: 'docx-paragraph',
      extractorVersion: 'v1',
      paragraphIndex: 5,
      headingPath: ['Overview'],
    };

    expect(formatLocator(locator)).toBe('Overview');
  });

  it('should format a docx-paragraph locator without a heading path', () => {
    const locator: Locator = {
      kind: 'docx-paragraph',
      extractorVersion: 'v1',
      paragraphIndex: 5,
      headingPath: [],
    };

    expect(formatLocator(locator)).toBe('¶5');
  });

  it('should format a text-block locator with a heading path', () => {
    const locator: Locator = {
      kind: 'text-block',
      extractorVersion: 'v1',
      blockIndex: 2,
      headingPath: ['Executive Summary'],
    };

    expect(formatLocator(locator)).toBe('Executive Summary');
  });

  it('should format a text-block locator with an empty heading path', () => {
    const locator: Locator = {
      kind: 'text-block',
      extractorVersion: 'v1',
      blockIndex: 0,
      headingPath: [],
    };

    expect(formatLocator(locator)).toBe('¶0');
  });

  it('should format a pptx-slide locator', () => {
    const locator: Locator = { kind: 'pptx-slide', extractorVersion: 'v1', slide: 4 };

    expect(formatLocator(locator)).toBe('slide 4');
  });
});

describe('locatorGroupKey', () => {
  it('groups pdf-page locators by page', () => {
    const locator: Locator = { kind: 'pdf-page', extractorVersion: 'v1', page: 3 };

    expect(locatorGroupKey(locator)).toBe('page:3');
  });

  it('groups xlsx-cell locators by sheet', () => {
    const locator: Locator = {
      kind: 'xlsx-cell',
      extractorVersion: 'v1',
      sheetName: 'Comps',
      cell: 'F2',
    };

    expect(locatorGroupKey(locator)).toBe('sheet:Comps');
  });

  it('groups xlsx-region locators by sheet', () => {
    const locator: Locator = {
      kind: 'xlsx-region',
      extractorVersion: 'v1',
      sheetName: 'Comps',
      range: 'A1:C10',
    };

    expect(locatorGroupKey(locator)).toBe('sheet:Comps');
  });

  it('groups docx-paragraph locators by top heading', () => {
    const locator: Locator = {
      kind: 'docx-paragraph',
      extractorVersion: 'v1',
      paragraphIndex: 5,
      headingPath: ['Overview', 'Cap rate'],
    };

    expect(locatorGroupKey(locator)).toBe('heading:Overview');
  });

  it('groups a headless docx-paragraph locator into a single untitled bucket', () => {
    const locator: Locator = {
      kind: 'docx-paragraph',
      extractorVersion: 'v1',
      paragraphIndex: 5,
      headingPath: [],
    };

    expect(locatorGroupKey(locator)).toBe('heading:');
  });

  it('groups text-block locators by top heading', () => {
    const locator: Locator = {
      kind: 'text-block',
      extractorVersion: 'v1',
      blockIndex: 2,
      headingPath: ['Executive Summary'],
    };

    expect(locatorGroupKey(locator)).toBe('heading:Executive Summary');
  });

  it('groups a headless text-block locator into a single untitled bucket', () => {
    const locator: Locator = {
      kind: 'text-block',
      extractorVersion: 'v1',
      blockIndex: 0,
      headingPath: [],
    };

    expect(locatorGroupKey(locator)).toBe('heading:');
  });

  it('groups pptx-slide locators by slide', () => {
    const locator: Locator = { kind: 'pptx-slide', extractorVersion: 'v1', slide: 4 };

    expect(locatorGroupKey(locator)).toBe('slide:4');
  });
});

describe('locatorGroupLabel', () => {
  it('labels a pdf-page group', () => {
    const locator: Locator = { kind: 'pdf-page', extractorVersion: 'v1', page: 3 };

    expect(locatorGroupLabel(locator)).toBe('Page 3');
  });

  it('labels an xlsx-cell group with the sheet name', () => {
    const locator: Locator = {
      kind: 'xlsx-cell',
      extractorVersion: 'v1',
      sheetName: 'Comps',
      cell: 'F2',
    };

    expect(locatorGroupLabel(locator)).toBe('Comps');
  });

  it('labels an xlsx-region group with the sheet name', () => {
    const locator: Locator = {
      kind: 'xlsx-region',
      extractorVersion: 'v1',
      sheetName: 'Comps',
      range: 'A1:C10',
    };

    expect(locatorGroupLabel(locator)).toBe('Comps');
  });

  it('labels a docx-paragraph group with the top heading', () => {
    const locator: Locator = {
      kind: 'docx-paragraph',
      extractorVersion: 'v1',
      paragraphIndex: 5,
      headingPath: ['Overview', 'Cap rate'],
    };

    expect(locatorGroupLabel(locator)).toBe('Overview');
  });

  it('labels a headless docx-paragraph group as an untitled section', () => {
    const locator: Locator = {
      kind: 'docx-paragraph',
      extractorVersion: 'v1',
      paragraphIndex: 5,
      headingPath: [],
    };

    expect(locatorGroupLabel(locator)).toBe('Untitled section');
  });

  it('labels a text-block group with the top heading', () => {
    const locator: Locator = {
      kind: 'text-block',
      extractorVersion: 'v1',
      blockIndex: 2,
      headingPath: ['Executive Summary'],
    };

    expect(locatorGroupLabel(locator)).toBe('Executive Summary');
  });

  it('labels a headless text-block group as an untitled section', () => {
    const locator: Locator = {
      kind: 'text-block',
      extractorVersion: 'v1',
      blockIndex: 0,
      headingPath: [],
    };

    expect(locatorGroupLabel(locator)).toBe('Untitled section');
  });

  it('labels a pptx-slide group', () => {
    const locator: Locator = { kind: 'pptx-slide', extractorVersion: 'v1', slide: 4 };

    expect(locatorGroupLabel(locator)).toBe('Slide 4');
  });
});

describe('pdfPageOf', () => {
  it('returns the page for a pdf-page locator', () => {
    const locator: Locator = { kind: 'pdf-page', extractorVersion: 'v1', page: 3 };

    expect(pdfPageOf(locator)).toBe(3);
  });

  it('returns null for an xlsx-cell locator', () => {
    const locator: Locator = {
      kind: 'xlsx-cell',
      extractorVersion: 'v1',
      sheetName: 'Comps',
      cell: 'F2',
    };

    expect(pdfPageOf(locator)).toBeNull();
  });

  it('returns null for an xlsx-region locator', () => {
    const locator: Locator = {
      kind: 'xlsx-region',
      extractorVersion: 'v1',
      sheetName: 'Comps',
      range: 'A1:C10',
    };

    expect(pdfPageOf(locator)).toBeNull();
  });

  it('returns null for a docx-paragraph locator', () => {
    const locator: Locator = {
      kind: 'docx-paragraph',
      extractorVersion: 'v1',
      paragraphIndex: 5,
      headingPath: [],
    };

    expect(pdfPageOf(locator)).toBeNull();
  });

  it('returns null for a text-block locator', () => {
    const locator: Locator = {
      kind: 'text-block',
      extractorVersion: 'v1',
      blockIndex: 0,
      headingPath: [],
    };

    expect(pdfPageOf(locator)).toBeNull();
  });

  it('returns null for a pptx-slide locator', () => {
    const locator: Locator = { kind: 'pptx-slide', extractorVersion: 'v1', slide: 4 };

    expect(pdfPageOf(locator)).toBeNull();
  });
});
