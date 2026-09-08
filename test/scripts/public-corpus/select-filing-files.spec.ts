import { selectFilingFiles } from '../../../scripts/public-corpus/lib/select-filing-files';
import {
  EXCLUDED_FILENAME_PATTERNS,
  EXHIBIT_INCLUDE_HINTS,
  FILE_EXTENSIONS,
} from '../../../scripts/public-corpus/lib/allowlist';

const RULES = {
  extensions: FILE_EXTENSIONS,
  excluded: EXCLUDED_FILENAME_PATTERNS,
  includeHints: EXHIBIT_INCLUDE_HINTS,
};

describe('selectFilingFiles', () => {
  it('marks the primary document with role primary and no exhibit hint', () => {
    const selected = selectFilingFiles([{ name: 'prologis-10k.htm' }], 'prologis-10k.htm', RULES);

    expect(selected).toEqual([{ name: 'prologis-10k.htm', role: 'primary', exhibitHint: null }]);
  });

  it('extracts the exhibit hint from ex31-1.htm and ex-99.1.htm', () => {
    const selected = selectFilingFiles(
      [{ name: 'ex31-1.htm' }, { name: 'ex-99.1.htm' }],
      'prologis-10k.htm',
      RULES,
    );

    expect(selected).toEqual([
      { name: 'ex31-1.htm', role: 'exhibit', exhibitHint: 'ex31' },
      { name: 'ex-99.1.htm', role: 'exhibit', exhibitHint: 'ex99' },
    ]);
  });

  it('drops an exhibit whose filename carries no include hint', () => {
    const selected = selectFilingFiles([{ name: 'ex-5.1.htm' }], 'prologis-10k.htm', RULES);

    expect(selected).toEqual([]);
  });

  it('excludes rendering pages, index/summary pages, and material-contract exhibits by pattern', () => {
    const items = [
      { name: 'R1.htm' },
      { name: 'prologis-10k-index.htm' },
      { name: 'FilingSummary.htm' },
      { name: 'Financial_Report.htm' },
      { name: 'ex-10.1.htm' },
      { name: 'ex4.1.htm' },
    ];

    const selected = selectFilingFiles(items, 'prologis-10k.htm', RULES);

    expect(selected).toEqual([]);
  });

  it('filters out an extension outside the allowlist', () => {
    const selected = selectFilingFiles([{ name: 'ex99-1.xml' }], 'prologis-10k.htm', RULES);

    expect(selected).toEqual([]);
  });

  it('accepts a pdf exhibit carrying an include hint', () => {
    const selected = selectFilingFiles([{ name: 'ex21-1.pdf' }], 'prologis-10k.htm', RULES);

    expect(selected).toEqual([{ name: 'ex21-1.pdf', role: 'exhibit', exhibitHint: 'ex21' }]);
  });
});
