import { sanitizeDownloadFilename } from '../../../../src/features/evidence/documents/sanitize-download-filename.util';

describe('sanitizeDownloadFilename', () => {
  it('should pass through a title that is already safe', () => {
    expect(sanitizeDownloadFilename('Q3 Rent Roll', 1, 'xlsx')).toBe('Q3_Rent_Roll-v1.xlsx');
  });

  it('should replace quotes with underscores', () => {
    expect(sanitizeDownloadFilename('The "Best" Deal', 2, 'pdf')).toBe('The__Best__Deal-v2.pdf');
  });

  it('should replace an embedded newline with an underscore', () => {
    expect(sanitizeDownloadFilename('Line One\nLine Two', 1, 'pdf')).toBe(
      'Line_One_Line_Two-v1.pdf',
    );
  });

  it('should replace a semicolon — the Content-Disposition parameter delimiter — with an underscore', () => {
    expect(sanitizeDownloadFilename('Report; Draft', 3, 'docx')).toBe('Report__Draft-v3.docx');
  });

  it('should replace non-ASCII characters with underscores', () => {
    expect(sanitizeDownloadFilename('Café Résumé', 1, 'pdf')).toBe('Caf__R_sum_-v1.pdf');
  });

  it('should fall back to a fixed name for an empty title', () => {
    expect(sanitizeDownloadFilename('', 1, 'pdf')).toBe('document-v1.pdf');
  });

  it('should fall back to a fixed name for a whitespace-only title', () => {
    expect(sanitizeDownloadFilename('   ', 1, 'pdf')).toBe('document-v1.pdf');
  });

  it('should produce the documented example for a title with quotes and a semicolon', () => {
    expect(sanitizeDownloadFilename('Q3 "Comps" Report; v2', 2, 'xlsx')).toBe(
      'Q3__Comps__Report__v2-v2.xlsx',
    );
  });
});
