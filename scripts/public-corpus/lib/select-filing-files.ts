export interface SelectedFilingFile {
  readonly name: string;
  readonly role: 'primary' | 'exhibit';
  readonly exhibitHint: string | null;
}

function extractExtension(name: string): string | undefined {
  const lastDotIndex = name.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === name.length - 1) {
    return undefined;
  }
  return name.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * Matches a filename against `includeHints` after stripping a dash right after `ex` — EDGAR
 * exhibit filenames spell the same hint both ways (`ex31-1.htm`, `ex-99.1.htm`), and this is the
 * one place that variance is normalized.
 */
function matchExhibitHint(name: string, includeHints: readonly string[]): string | undefined {
  const normalized = name.toLowerCase().replace(/^ex-/, 'ex');
  return includeHints.find((hint) => normalized.startsWith(hint));
}

/**
 * Selects an accession directory's files worth fetching: the filing's own `primaryDocument`
 * (role `primary`, no exhibit check) plus any exhibit whose filename carries one of
 * `rules.includeHints` (role `exhibit`) — everything else (rendering pages, index/summary
 * pages, material-contract exhibits, an extension outside `rules.extensions`) is dropped, not
 * merely deprioritized. `rules.excluded` is checked against the primary document too, but no
 * primary document filed by EDGAR has ever matched one of those patterns in practice; the check
 * stays because `EXCLUDED_FILENAME_PATTERNS` fails CLOSED on suspicious content, and the primary
 * document is not exempt from a policy meant to keep non-filed pages out of the corpus.
 */
export function selectFilingFiles(
  items: readonly { name: string; size?: string }[],
  primaryDocument: string,
  rules: {
    extensions: readonly string[];
    excluded: readonly RegExp[];
    includeHints: readonly string[];
  },
): readonly SelectedFilingFile[] {
  const results: SelectedFilingFile[] = [];

  for (const item of items) {
    const extension = extractExtension(item.name);
    if (!extension || !rules.extensions.includes(extension)) {
      continue;
    }
    if (rules.excluded.some((pattern) => pattern.test(item.name))) {
      continue;
    }

    if (item.name === primaryDocument) {
      results.push({ name: item.name, role: 'primary', exhibitHint: null });
      continue;
    }

    const hint = matchExhibitHint(item.name, rules.includeHints);
    if (hint) {
      results.push({ name: item.name, role: 'exhibit', exhibitHint: hint });
    }
  }

  return results;
}
