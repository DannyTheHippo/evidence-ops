import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ParsedElement } from '../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { parserForFile } from '../../eval/parser-for-file';
import type { EvalCase, Locator } from '../../eval/dataset/schema';
import { buildNumericCase, type NumericCaseSource } from './lib/build-numeric-case';
import { readCorpusManifest, type CorpusFiling, type CorpusManifest } from './lib/corpus-manifest';
import { locateValue } from './lib/locate-value';
import { renderedForms } from './lib/render-values';
import {
  findRestatements,
  selectXbrlFacts,
  type CompanyFactsJson,
  type XbrlFact,
} from './lib/select-xbrl-facts';
import { labelTokens, XBRL_CONCEPTS, type XbrlConcept } from './lib/xbrl-concepts';

/**
 * Authors XBRL-derived numeric cases and restatement candidates from the ingested public corpus —
 * no network call, no model call: every fact, period and rendered form comes from the companyfacts
 * JSON already fetched (5.7/5.11) and the filing bytes already on disk (5.13).
 *
 *   npm run corpus:author-numeric -- [--manifest <path>] [--corpus-dir <dir>] [--out <dir>]
 *     [--per-registrant-concept <n>] [--min-registrants <n>]
 */

const DEFAULT_MANIFEST_PATH = 'eval/public/corpus-manifest.json';
const DEFAULT_CORPUS_DIR = 'eval/public/corpus';
const DEFAULT_OUT_DIR = 'eval/public/dataset/generated';
const DEFAULT_PER_REGISTRANT_CONCEPT = 2;
const DEFAULT_MIN_REGISTRANTS = 8;
const ENTITY_DISAMBIGUATION_CAP = 10;

interface AuthorArgs {
  readonly manifestPath: string;
  readonly corpusDir: string;
  readonly outDir: string;
  readonly perRegistrantConcept: number;
  readonly minRegistrants: number;
}

function parseArgs(argv: readonly string[]): AuthorArgs {
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let corpusDir = DEFAULT_CORPUS_DIR;
  let outDir = DEFAULT_OUT_DIR;
  let perRegistrantConcept = DEFAULT_PER_REGISTRANT_CONCEPT;
  let minRegistrants = DEFAULT_MIN_REGISTRANTS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') {
      manifestPath = argv[index + 1];
      index += 1;
    } else if (arg === '--corpus-dir') {
      corpusDir = argv[index + 1];
      index += 1;
    } else if (arg === '--out') {
      outDir = argv[index + 1];
      index += 1;
    } else if (arg === '--per-registrant-concept') {
      perRegistrantConcept = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--min-registrants') {
      minRegistrants = Number(argv[index + 1]);
      index += 1;
    }
  }

  return { manifestPath, corpusDir, outDir, perRegistrantConcept, minRegistrants };
}

/** One (registrant, concept, period) worth of evidence: a value uncontested across every
 *  accession in the corpus that reports it — a period with two or more distinct values is a
 *  restatement, handled by `findRestatements` instead, never authored as a plain numeric case. */
interface CandidateFact {
  readonly registrant: { readonly cik: string; readonly name: string };
  readonly concept: XbrlConcept;
  readonly start: string | null;
  readonly end: string;
  readonly val: number;
  readonly accessions: readonly string[];
}

function periodKey(concept: XbrlConcept, start: string | null, end: string): string {
  return `${concept.name}|${start ?? ''}|${end}`;
}

/** The uncontested (registrant, concept, period) candidates for one registrant, capped at
 *  `perRegistrantConcept` periods per concept, most recent `end` first. */
function selectCandidates(
  registrant: { readonly cik: string; readonly name: string },
  facts: readonly XbrlFact[],
  restatedKeys: ReadonlySet<string>,
  perRegistrantConcept: number,
): readonly CandidateFact[] {
  const candidates: CandidateFact[] = [];

  for (const concept of XBRL_CONCEPTS) {
    const conceptFacts = facts.filter((fact) => fact.concept.name === concept.name);
    const byPeriod = new Map<string, XbrlFact[]>();
    for (const fact of conceptFacts) {
      const key = periodKey(concept, fact.start, fact.end);
      if (restatedKeys.has(key)) {
        continue;
      }
      const group = byPeriod.get(key) ?? [];
      group.push(fact);
      byPeriod.set(key, group);
    }

    const periods = [...byPeriod.values()].sort((left, right) =>
      left[0].end < right[0].end ? 1 : -1,
    );
    for (const periodFacts of periods.slice(0, perRegistrantConcept)) {
      const accessions = [...new Set(periodFacts.map((fact) => fact.accession))].sort();
      candidates.push({
        registrant,
        concept,
        start: periodFacts[0].start,
        end: periodFacts[0].end,
        val: periodFacts[0].val,
        accessions,
      });
    }
  }

  return candidates;
}

interface ParsedFileCache {
  get(filePath: string): Promise<readonly ParsedElement[]>;
}

function createParsedFileCache(corpusDir: string): ParsedFileCache {
  const cache = new Map<string, Promise<readonly ParsedElement[]>>();
  return {
    async get(filePath: string): Promise<readonly ParsedElement[]> {
      const cached = cache.get(filePath);
      if (cached) {
        return cached;
      }
      const pending = (async (): Promise<readonly ParsedElement[]> => {
        const bytes = await readFile(path.join(corpusDir, filePath));
        const parser = parserForFile(filePath);
        return (await parser.parse(bytes)).elements;
      })();
      cache.set(filePath, pending);
      return pending;
    },
  };
}

function primaryFile(filing: CorpusFiling): { readonly path: string } | undefined {
  return filing.files.find((file) => file.role === 'primary' && !file.duplicateOf);
}

interface LocatedCandidate {
  readonly candidate: CandidateFact;
  readonly baseFiling: CorpusFiling;
  readonly baseAccession: string;
  readonly matchedText: string;
  readonly scale: number;
  readonly labelMatched: string;
  readonly expectedLocators: readonly Locator[];
}

/**
 * Runs `locateValue` over every accession that reports `candidate`'s value — every located element
 * becomes an expected locator, so a correct citation of a 10-Q's comparative column is never scored
 * as a miss against a 10-K primary statement (ADR-0031). The case's own metadata (form, filingDate,
 * matched text) comes from the first accession, in ascending order, that locates successfully.
 */
async function locateCandidate(
  candidate: CandidateFact,
  filingsByAccession: ReadonlyMap<string, CorpusFiling>,
  cache: ParsedFileCache,
): Promise<LocatedCandidate | undefined> {
  const forms = renderedForms(candidate.val, candidate.concept.valueType);
  const tokens = labelTokens(candidate.concept);

  const locators: Locator[] = [];
  let base:
    | {
        filing: CorpusFiling;
        accession: string;
        matchedText: string;
        scale: number;
        labelMatched: string;
      }
    | undefined;

  for (const accession of candidate.accessions) {
    const filing = filingsByAccession.get(accession);
    const file = filing ? primaryFile(filing) : undefined;
    if (!filing || !file) {
      continue;
    }
    const elements = await cache.get(file.path);
    const located = locateValue(elements, forms, tokens, file.path);
    if ('reason' in located) {
      continue;
    }
    locators.push(located.locator);
    base ??= {
      filing,
      accession,
      matchedText: located.matchedText,
      scale: located.scale,
      labelMatched: located.labelMatched,
    };
  }

  if (!base || locators.length === 0) {
    return undefined;
  }

  return {
    candidate,
    baseFiling: base.filing,
    baseAccession: base.accession,
    matchedText: base.matchedText,
    scale: base.scale,
    labelMatched: base.labelMatched,
    expectedLocators: locators,
  };
}

interface AuthoringReport {
  readonly registrantsWithCases: number;
  readonly numericCases: number;
  readonly entityDisambiguationCases: number;
  readonly restatementCandidates: number;
  readonly dropReasons: Record<string, number>;
}

function renderReport(report: AuthoringReport, args: AuthorArgs): string {
  const lines = [
    '# XBRL numeric-case authoring report',
    '',
    `- registrants with at least one case: ${report.registrantsWithCases} (minimum ${args.minRegistrants})`,
    `- numeric cases: ${report.numericCases}`,
    `- entity-disambiguation cases: ${report.entityDisambiguationCases}`,
    `- restatement candidates: ${report.restatementCandidates}`,
    '',
    '## Drop reasons',
    '',
  ];
  const reasons = Object.entries(report.dropReasons).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (reasons.length === 0) {
    lines.push('none');
  } else {
    for (const [reason, count] of reasons) {
      lines.push(`- ${reason}: ${count}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest: CorpusManifest = await readCorpusManifest(args.manifestPath);
  const cache = createParsedFileCache(args.corpusDir);

  const filingsByAccession = new Map(manifest.filings.map((filing) => [filing.accession, filing]));

  const allCandidates: { candidate: CandidateFact; registrant: string }[] = [];
  const numericCases: EvalCase[] = [];
  const restatements: {
    concept: string;
    registrant: string;
    start: string | null;
    end: string;
    values: readonly { accession: string; form: string; val: number }[];
    located?: readonly { accession: string; locator: Locator; matchedText: string }[];
  }[] = [];
  const dropReasons: Record<string, number> = {};
  const registrantsWithCases = new Set<string>();

  const drop = (reason: string): void => {
    dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
  };

  const perRegistrant: {
    readonly registrant: CorpusManifest['registrants'][number];
    readonly candidates: readonly CandidateFact[];
  }[] = [];

  for (const registrant of manifest.registrants) {
    const accessionsInCorpus = new Set(
      manifest.filings
        .filter((filing) => filing.cik === registrant.cik && filing.selected)
        .map((filing) => filing.accession),
    );
    if (accessionsInCorpus.size === 0) {
      drop('registrant has no selected filings');
      continue;
    }

    const companyFactsPath = path.join(args.corpusDir, registrant.companyFacts.path);
    const companyFacts = JSON.parse(await readFile(companyFactsPath, 'utf8')) as CompanyFactsJson;

    const facts = selectXbrlFacts(companyFacts, registrant.cik, accessionsInCorpus, XBRL_CONCEPTS);
    const restatementGroups = findRestatements(facts);
    const restatedKeys = new Set(
      restatementGroups.map((group) => periodKey(group.concept, group.start, group.end)),
    );

    for (const group of restatementGroups) {
      restatements.push({
        concept: group.concept.name,
        registrant: registrant.name,
        start: group.start,
        end: group.end,
        values: group.values,
      });
    }

    const candidates = selectCandidates(
      { cik: registrant.cik, name: registrant.name },
      facts,
      restatedKeys,
      args.perRegistrantConcept,
    );
    perRegistrant.push({ registrant, candidates });
    for (const candidate of candidates) {
      allCandidates.push({ candidate, registrant: registrant.name });
    }
  }

  // Cross-registrant map, built before any location work: a period the corpus reports for more
  // than one registrant is a distractor candidate for `entity-disambiguation`.
  const registrantsByPeriod = new Map<string, Set<string>>();
  for (const { candidate, registrant } of allCandidates) {
    const key = periodKey(candidate.concept, candidate.start, candidate.end);
    const set = registrantsByPeriod.get(key) ?? new Set<string>();
    set.add(registrant);
    registrantsByPeriod.set(key, set);
  }

  let caseIndex = 0;
  let entityDisambiguationCount = 0;

  for (const { registrant, candidates } of perRegistrant) {
    for (const candidate of candidates) {
      const key = periodKey(candidate.concept, candidate.start, candidate.end);
      const distractors = [...(registrantsByPeriod.get(key) ?? [])].filter(
        (name) => name !== registrant.name,
      );
      const isDisambiguation =
        distractors.length > 0 && entityDisambiguationCount < ENTITY_DISAMBIGUATION_CAP;

      const located = await locateCandidate(candidate, filingsByAccession, cache);
      if (!located) {
        drop('value not located in any reporting accession');
        continue;
      }

      const source: NumericCaseSource = {
        registrant: registrant.name,
        concept: candidate.concept,
        form: located.baseFiling.form,
        filingDate: located.baseFiling.filingDate,
        accession: located.baseAccession,
        start: candidate.start,
        end: candidate.end,
        val: candidate.val,
        unit: candidate.concept.unit,
        scale: located.scale,
        matchedText: located.matchedText,
        labelMatched: located.labelMatched,
        expectedLocators: located.expectedLocators,
      };

      const id = `num-${String(caseIndex + 1).padStart(3, '0')}`;
      const evalCase = buildNumericCase(id, caseIndex, source, {
        authoringClass: isDisambiguation ? 'entity-disambiguation' : 'numeric',
        distractorRegistrant: isDisambiguation ? distractors[0] : undefined,
      });
      numericCases.push(evalCase);
      registrantsWithCases.add(registrant.name);
      caseIndex += 1;
      if (isDisambiguation) {
        entityDisambiguationCount += 1;
      }
    }
  }

  // Locate both sides of every restatement candidate, when possible, so `restatements.json` carries
  // ready-to-use locators for 5.16's hand-authored `restatement-conflict` cases.
  for (const restatement of restatements) {
    const located: { accession: string; locator: Locator; matchedText: string }[] = [];
    for (const { accession, val } of restatement.values) {
      const filing = filingsByAccession.get(accession);
      const file = filing ? primaryFile(filing) : undefined;
      const concept = XBRL_CONCEPTS.find((candidate) => candidate.name === restatement.concept);
      if (!filing || !file || !concept) {
        continue;
      }
      const elements = await cache.get(file.path);
      const valueForms = renderedForms(val, concept.valueType);
      const result = locateValue(elements, valueForms, labelTokens(concept), file.path);
      if ('reason' in result) {
        continue;
      }
      located.push({ accession, locator: result.locator, matchedText: result.matchedText });
    }
    if (located.length === restatement.values.length) {
      restatement.located = located;
    }
  }

  await mkdir(args.outDir, { recursive: true });
  await writeFile(
    path.join(args.outDir, 'numeric.json'),
    `${JSON.stringify(numericCases, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(args.outDir, 'restatements.json'),
    `${JSON.stringify(restatements, null, 2)}\n`,
    'utf8',
  );

  const report: AuthoringReport = {
    registrantsWithCases: registrantsWithCases.size,
    numericCases: numericCases.length,
    entityDisambiguationCases: entityDisambiguationCount,
    restatementCandidates: restatements.length,
    dropReasons,
  };
  await writeFile(
    path.join(args.outDir, 'authoring-report.md'),
    renderReport(report, args),
    'utf8',
  );

  console.log(
    `corpus:author-numeric — ${report.numericCases} numeric case(s) (${report.entityDisambiguationCases} entity-disambiguation) ` +
      `across ${report.registrantsWithCases} registrant(s), ${report.restatementCandidates} restatement candidate(s)`,
  );
  if (report.registrantsWithCases < args.minRegistrants) {
    console.error(
      `corpus:author-numeric — only ${report.registrantsWithCases} registrant(s) produced a case, below --min-registrants ${args.minRegistrants}`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? `corpus:author-numeric: fatal error — ${error.message}` : error,
    );
    process.exitCode = 1;
  });
}
