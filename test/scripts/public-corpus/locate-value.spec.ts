import type { ParsedElement } from '../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { locateValue } from '../../../scripts/public-corpus/lib/locate-value';

const EXTRACTOR_VERSION = 'test';

function xlsxCell(sheet: string, cell: string, text: string): ParsedElement {
  return {
    text,
    locator: { kind: 'xlsx-cell', sheetName: sheet, cell, extractorVersion: EXTRACTOR_VERSION },
    headingPath: [],
  };
}

function textBlock(blockIndex: number, text: string): ParsedElement {
  return {
    text,
    locator: {
      kind: 'text-block',
      blockIndex,
      headingPath: [],
      extractorVersion: EXTRACTOR_VERSION,
    },
    headingPath: [],
  };
}

const FORMS = [{ text: '1,234,567', scale: 1 }];

describe('locateValue', () => {
  it('resolves a unique xlsx-cell candidate labelled by column A of the same row', () => {
    const elements = [
      xlsxCell('HTML-TABLE-1', 'A2', 'Total revenues'),
      xlsxCell('HTML-TABLE-1', 'B2', 'Amount: 1,234,567 total'),
    ];

    const result = locateValue(elements, FORMS, ['revenues'], 'prologis/10k.htm');

    expect(result).toEqual({
      locator: { kind: 'xlsx-cell', file: 'prologis/10k.htm', sheet: 'HTML-TABLE-1', cell: 'B2' },
      matchedText: '1,234,567',
      scale: 1,
      labelMatched: 'Total revenues',
    });
  });

  it('resolves to the one labelled candidate even when the form text also appears unlabelled', () => {
    const elements = [
      xlsxCell('HTML-TABLE-1', 'A2', 'Total revenues'),
      xlsxCell('HTML-TABLE-1', 'B2', '1,234,567'),
      xlsxCell('HTML-TABLE-1', 'A5', 'Some other line item'),
      xlsxCell('HTML-TABLE-1', 'B5', '1,234,567'),
    ];

    const result = locateValue(elements, FORMS, ['revenues'], 'prologis/10k.htm');

    expect(result).toEqual({
      locator: { kind: 'xlsx-cell', file: 'prologis/10k.htm', sheet: 'HTML-TABLE-1', cell: 'B2' },
      matchedText: '1,234,567',
      scale: 1,
      labelMatched: 'Total revenues',
    });
  });

  it('is ambiguous when two candidates both match the form and both carry a matching label', () => {
    const elements = [
      xlsxCell('HTML-TABLE-1', 'A2', 'Total assets'),
      xlsxCell('HTML-TABLE-1', 'B2', '1,234,567'),
      xlsxCell('HTML-TABLE-1', 'A5', 'Total assets held for sale'),
      xlsxCell('HTML-TABLE-1', 'B5', '1,234,567'),
    ];

    const result = locateValue(elements, FORMS, ['assets'], 'prologis/10k.htm');

    expect(result).toEqual({ reason: 'ambiguous' });
  });

  it('is not-found when no element contains any rendered form', () => {
    const elements = [
      xlsxCell('HTML-TABLE-1', 'A2', 'Total revenues'),
      xlsxCell('HTML-TABLE-1', 'B2', '999'),
    ];

    const result = locateValue(elements, FORMS, ['revenues'], 'prologis/10k.htm');

    expect(result).toEqual({ reason: 'not-found' });
  });

  it('is not-found when the only matching candidate carries no label word', () => {
    const elements = [
      xlsxCell('HTML-TABLE-1', 'A2', 'Unrelated line item'),
      xlsxCell('HTML-TABLE-1', 'B2', '1,234,567'),
    ];

    const result = locateValue(elements, FORMS, ['revenues'], 'prologis/10k.htm');

    expect(result).toEqual({ reason: 'not-found' });
  });

  it('never treats a column-A cell as its own label', () => {
    const elements = [xlsxCell('HTML-TABLE-1', 'A2', 'Revenues 1,234,567 total')];

    const result = locateValue(elements, FORMS, ['revenues'], 'prologis/10k.htm');

    expect(result).toEqual({ reason: 'not-found' });
  });

  it('resolves a text-block whose label and value are tab-joined in the same row', () => {
    const elements = [textBlock(3, 'Total revenues\t1,234,567')];

    const result = locateValue(elements, FORMS, ['revenues'], 'prologis/10k.htm');

    expect(result).toEqual({
      locator: { kind: 'text-block', file: 'prologis/10k.htm', blockIndex: 3 },
      matchedText: '1,234,567',
      scale: 1,
      labelMatched: 'Total revenues\t1,234,567',
    });
  });
});
