import type { XbrlConcept } from './xbrl-concepts';

/** One raw entry in `facts[taxonomy][concept].units[unit][]` (plan Assumptions 4). `start` is
 *  absent for an instant fact (a balance-sheet line, e.g. `Assets`); present for a duration fact
 *  (e.g. `Revenues`). `fy`/`fp` describe the filing's own fiscal year/period, never the fact's own
 *  period — a comparative-column fact in a 10-Q can carry the prior fiscal year's `fy` while its
 *  `start`/`end` are the only trustworthy period. */
export interface CompanyFactsUnitEntry {
  readonly start?: string;
  readonly end: string;
  readonly val: number;
  readonly accn: string;
  readonly fy: number;
  readonly fp: string;
  readonly form: string;
  readonly filed: string;
}

export interface CompanyFactsJson {
  readonly cik: number;
  readonly entityName: string;
  readonly facts: {
    readonly [taxonomy: string]: {
      readonly [concept: string]: {
        readonly label?: string;
        readonly units: { readonly [unit: string]: readonly CompanyFactsUnitEntry[] };
      };
    };
  };
}

export interface XbrlFact {
  readonly cik: string;
  readonly accession: string;
  readonly form: string;
  readonly concept: XbrlConcept;
  readonly start: string | null;
  readonly end: string;
  readonly fy: number;
  readonly fp: string;
  readonly val: number;
}

/**
 * Every `concepts` fact a registrant's companyfacts JSON reports under an accession in
 * `accessionsInCorpus` — the accessions actually selected and (eventually) ingested, so a fact
 * pointing outside the corpus is never selected in the first place.
 *
 * Deduped per (concept, accession, start, end): the companyfacts API occasionally repeats an
 * identical entry for a period within the same accession (an unused dimensional context collapsing
 * to the same non-dimensional fact). Deduping is scoped to a single accession on purpose — two
 * *different* accessions reporting the same (concept, start, end) are kept as separate facts, one
 * per accession, because that is exactly the shape `findRestatements` needs to see a period reported
 * more than once, and it is how `author-numeric-cases.ts` finds every accession reporting a value
 * (a 10-Q's comparative column and the 10-K it echoes both stay in this list).
 */
export function selectXbrlFacts(
  companyFacts: CompanyFactsJson,
  cik: string,
  accessionsInCorpus: ReadonlySet<string>,
  concepts: readonly XbrlConcept[],
): readonly XbrlFact[] {
  const facts: XbrlFact[] = [];

  for (const concept of concepts) {
    const entries = companyFacts.facts[concept.taxonomy]?.[concept.name]?.units[concept.unit] ?? [];
    const seenPerAccession = new Set<string>();

    for (const entry of entries) {
      if (!accessionsInCorpus.has(entry.accn)) {
        continue;
      }
      const dedupeKey = `${entry.accn}|${entry.start ?? ''}|${entry.end}`;
      if (seenPerAccession.has(dedupeKey)) {
        continue;
      }
      seenPerAccession.add(dedupeKey);

      facts.push({
        cik,
        accession: entry.accn,
        form: entry.form,
        concept,
        start: entry.start ?? null,
        end: entry.end,
        fy: entry.fy,
        fp: entry.fp,
        val: entry.val,
      });
    }
  }

  return facts;
}

/**
 * Groups `facts` (from a single registrant — mixing registrants here would flag two different
 * companies' unrelated figures as a "restatement") by (concept, start, end) and returns every group
 * where two or more accessions report a different `val` for that same period — a genuine
 * restatement, not a duplicate report of the same figure.
 */
export function findRestatements(facts: readonly XbrlFact[]): readonly {
  readonly concept: XbrlConcept;
  readonly start: string | null;
  readonly end: string;
  readonly values: readonly {
    readonly accession: string;
    readonly form: string;
    readonly val: number;
  }[];
}[] {
  interface Group {
    readonly concept: XbrlConcept;
    readonly start: string | null;
    readonly end: string;
    readonly values: { accession: string; form: string; val: number }[];
  }

  const groups = new Map<string, Group>();
  for (const fact of facts) {
    const key = `${fact.concept.name}|${fact.start ?? ''}|${fact.end}`;
    let group = groups.get(key);
    if (!group) {
      group = { concept: fact.concept, start: fact.start, end: fact.end, values: [] };
      groups.set(key, group);
    }
    group.values.push({ accession: fact.accession, form: fact.form, val: fact.val });
  }

  return [...groups.values()].filter((group) => new Set(group.values.map((v) => v.val)).size >= 2);
}
