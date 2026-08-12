import { describe, expect, it } from 'vitest';
import type { Locator } from '../api/client';
import { formatLocator } from './locator';

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
