import {
  contentMatchesDeclaredKind,
  resolveUploadKind,
} from '../../../../src/features/evidence/documents/documents.constant';

describe('resolveUploadKind', () => {
  describe('unambiguous MIME types — trusted outright regardless of filename', () => {
    it.each([
      ['application/pdf', 'anything.bin', 'pdf'],
      [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'anything.bin',
        'docx',
      ],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'anything.bin', 'xlsx'],
      [
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'anything.bin',
        'pptx',
      ],
      ['text/csv', 'anything.bin', 'csv'],
      ['text/tab-separated-values', 'anything.bin', 'tsv'],
      ['text/markdown', 'anything.bin', 'md'],
    ])('resolves %s to %s', (mimetype, filename, expected) => {
      expect(resolveUploadKind(mimetype, filename)).toBe(expected);
    });
  });

  describe('ambiguous MIME types — resolved strictly by extension', () => {
    it.each([
      ['application/vnd.ms-excel', 'comps.csv', 'csv'],
      ['application/vnd.ms-excel', 'comps.xlsx', 'xlsx'],
      ['text/plain', 'notes.txt', 'txt'],
      ['text/plain', 'notes.md', 'md'],
      ['text/plain', 'notes.tsv', 'tsv'],
      ['application/octet-stream', 'report.pdf', 'pdf'],
      ['application/octet-stream', 'deck.pptx', 'pptx'],
      ['', 'notes.docx', 'docx'],
    ])('resolves %s + %s to %s', (mimetype, filename, expected) => {
      expect(resolveUploadKind(mimetype, filename)).toBe(expected);
    });
  });

  it('rejects application/vnd.ms-excel + .xls — the legacy binary this project does not support, not guessed as a spreadsheet', () => {
    expect(resolveUploadKind('application/vnd.ms-excel', 'legacy.xls')).toBeUndefined();
  });

  it('rejects application/octet-stream + an extension outside the allowlist', () => {
    expect(resolveUploadKind('application/octet-stream', 'archive.zip')).toBeUndefined();
  });

  it('rejects an empty MIME type with an extension outside the allowlist', () => {
    expect(resolveUploadKind('', 'archive.zip')).toBeUndefined();
  });

  it('rejects an ambiguous MIME with no extension at all', () => {
    expect(resolveUploadKind('application/octet-stream', 'noextension')).toBeUndefined();
  });

  it('rejects an ambiguous MIME with a trailing-dot filename — nothing follows the last dot', () => {
    expect(resolveUploadKind('application/octet-stream', 'report.')).toBeUndefined();
  });

  it('resolves an ambiguous MIME by the last of multiple dots in the filename', () => {
    expect(resolveUploadKind('application/vnd.ms-excel', 'report.2025.csv')).toBe('csv');
  });

  it('matches the extension case-insensitively', () => {
    expect(resolveUploadKind('application/vnd.ms-excel', 'COMPS.CSV')).toBe('csv');
  });

  it('rejects a MIME type that is neither unambiguous nor in the ambiguous set', () => {
    expect(resolveUploadKind('image/png', 'photo.png')).toBeUndefined();
  });
});

describe('contentMatchesDeclaredKind', () => {
  const pdfBytes = Buffer.from('%PDF-1.7\nrest of the file', 'ascii');
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  const plainTextBytes = Buffer.from('Northgate Business Park comps', 'utf-8');

  it('matches a PDF-signed buffer declared as pdf', () => {
    expect(contentMatchesDeclaredKind(pdfBytes, 'pdf')).toBe(true);
  });

  it('rejects a PDF-signed buffer declared as txt — the report.txt-sent-as-a-PDF case', () => {
    expect(contentMatchesDeclaredKind(pdfBytes, 'txt')).toBe(false);
  });

  it.each([['docx'], ['xlsx'], ['pptx']] as const)(
    'matches a ZIP-signed buffer declared as %s',
    (sourceKind) => {
      expect(contentMatchesDeclaredKind(zipBytes, sourceKind)).toBe(true);
    },
  );

  it('rejects a ZIP-signed buffer declared as pdf — the two binary families never cross-match', () => {
    expect(contentMatchesDeclaredKind(zipBytes, 'pdf')).toBe(false);
  });

  it('rejects a declared binary kind whose bytes carry no recognized signature at all', () => {
    expect(contentMatchesDeclaredKind(plainTextBytes, 'xlsx')).toBe(false);
  });

  it.each([['txt'], ['md'], ['csv'], ['tsv']] as const)(
    'matches ordinary text bytes declared as %s — no binary signature to contradict them',
    (sourceKind) => {
      expect(contentMatchesDeclaredKind(plainTextBytes, sourceKind)).toBe(true);
    },
  );

  it('rejects a declared text kind whose bytes actually carry a PDF signature', () => {
    expect(contentMatchesDeclaredKind(pdfBytes, 'csv')).toBe(false);
  });

  it('rejects a declared text kind whose bytes actually carry a ZIP signature', () => {
    expect(contentMatchesDeclaredKind(zipBytes, 'md')).toBe(false);
  });

  it('matches a buffer shorter than any known signature against a declared text kind', () => {
    expect(contentMatchesDeclaredKind(Buffer.from([0x61]), 'txt')).toBe(true);
  });

  it('rejects a buffer shorter than the PDF signature against a declared pdf kind', () => {
    expect(contentMatchesDeclaredKind(Buffer.from([0x25, 0x50]), 'pdf')).toBe(false);
  });
});
