import type { EvalCase, Locator } from '../../../eval/dataset/schema';
import type { XbrlConcept } from './xbrl-concepts';

/**
 * The period phrase a numeric question names, built from the fact's own `start`/`end` only — never
 * `fy`/`fp`, which describe the *filing*, not necessarily the period a comparative-column fact
 * covers (ADR-0031). An instant fact (no `start`, e.g. a balance-sheet line) is phrased "as of";
 * a duration fact is phrased by its span.
 */
export function periodPhrase(start: string | null, end: string): string {
  return start === null ? `period ended ${end}` : `period from ${start} to ${end}`;
}

const QUESTION_TEMPLATES: readonly ((params: {
  registrant: string;
  label: string;
  form: string;
  filingDate: string;
  phrase: string;
}) => string)[] = [
  ({ registrant, label, phrase }) => `What was ${registrant}'s ${label} for the ${phrase}?`,
  ({ registrant, label, form, filingDate, phrase }) =>
    `According to ${registrant}'s ${form} filed ${filingDate}, what ${label} did it report for ${phrase}?`,
  ({ registrant, label, phrase }) => `State ${registrant}'s ${label} as reported for ${phrase}.`,
];

export interface NumericCaseSource {
  readonly registrant: string;
  readonly concept: XbrlConcept;
  readonly form: string;
  readonly filingDate: string;
  readonly accession: string;
  readonly start: string | null;
  readonly end: string;
  readonly val: number;
  readonly unit: string;
  readonly scale: number;
  readonly matchedText: string;
  readonly labelMatched: string;
  readonly expectedLocators: readonly Locator[];
}

export interface NumericCaseOptions {
  readonly authoringClass: 'numeric' | 'entity-disambiguation';
  readonly distractorRegistrant?: string;
}

/**
 * Builds one `EvalCase` from a located XBRL fact. Pure: every field is derived from `source` and
 * `options`, nothing read from disk. `expectedAnswerContains` is the exact rendered text
 * `locateValue` matched in the source document, so the schema-required substring check holds by
 * construction.
 */
export function buildNumericCase(
  id: string,
  index: number,
  source: NumericCaseSource,
  options: NumericCaseOptions,
): EvalCase {
  const phrase = periodPhrase(source.start, source.end);
  const template = QUESTION_TEMPLATES[index % QUESTION_TEMPLATES.length];
  const question = template({
    registrant: source.registrant,
    label: source.concept.label,
    form: source.form,
    filingDate: source.filingDate,
    phrase,
  });

  const distractorNote =
    options.authoringClass === 'entity-disambiguation' && options.distractorRegistrant
      ? ` distractor=${options.distractorRegistrant}`
      : '';

  return {
    id,
    category: 'answerable',
    question,
    expectedLocators: [...source.expectedLocators],
    expectedAnswerContains: [source.matchedText],
    expectedOutcome: 'answer',
    notes:
      `concept=${source.concept.name} accession=${source.accession} start=${source.start ?? 'null'} ` +
      `end=${source.end} val=${source.val} unit=${source.unit} scale=${source.scale} ` +
      `labelMatched="${source.labelMatched}"${distractorNote}`,
    authoring: {
      method: 'xbrl',
      class: options.authoringClass,
      source: `${source.concept.name}@${source.accession}`,
    },
  };
}
