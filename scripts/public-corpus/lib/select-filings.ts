/**
 * The subset of a registrant's `data.sec.gov/submissions/CIK<cik>.json` response this project
 * reads. `filings.recent` is columnar — parallel arrays indexed together, not an array of
 * per-filing objects (plan Assumptions 3).
 */
export interface SubmissionsJson {
  readonly cik: string;
  readonly name: string;
  readonly filings: {
    readonly recent: {
      readonly accessionNumber: readonly string[];
      readonly form: readonly string[];
      readonly filingDate: readonly string[];
      readonly reportDate: readonly string[];
      readonly primaryDocument: readonly string[];
    };
  };
}

export interface SelectedFiling {
  readonly accession: string;
  readonly form: string;
  readonly filingDate: string;
  readonly reportDate: string | null;
  readonly primaryDocument: string;
}

/**
 * Selects the filings in `options.forms` filed within `[filedFrom, filedTo]` (both inclusive),
 * ordered most-recent-first and, within the same date, `10-K` before `10-Q` — the order the
 * corpus walk (§ Architecture decision) and the sizing probe (5.8) both depend on. `form` is
 * matched exactly, so an amendment like `10-K/A` is excluded by construction, never by a
 * separate filter. EDGAR renders a missing `reportDate` as `""`, normalized here to `null`.
 */
export function selectFilings(
  submissions: SubmissionsJson,
  options: { forms: readonly string[]; filedFrom: string; filedTo: string },
): readonly SelectedFiling[] {
  const { accessionNumber, form, filingDate, reportDate, primaryDocument } =
    submissions.filings.recent;

  const selected: SelectedFiling[] = [];
  for (let index = 0; index < accessionNumber.length; index += 1) {
    if (!options.forms.includes(form[index])) {
      continue;
    }
    if (filingDate[index] < options.filedFrom || filingDate[index] > options.filedTo) {
      continue;
    }
    selected.push({
      accession: accessionNumber[index],
      form: form[index],
      filingDate: filingDate[index],
      reportDate: reportDate[index] ? reportDate[index] : null,
      primaryDocument: primaryDocument[index],
    });
  }

  return selected.sort((left, right) => {
    if (left.filingDate !== right.filingDate) {
      return left.filingDate < right.filingDate ? 1 : -1;
    }
    if (left.form !== right.form) {
      return left.form === '10-K' ? -1 : 1;
    }
    return left.accession.localeCompare(right.accession);
  });
}
