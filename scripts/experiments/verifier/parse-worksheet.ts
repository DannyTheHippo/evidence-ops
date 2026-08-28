import type {
  Adjudication,
  AdjudicationParseError,
  AdjudicationRow,
  ParsedWorksheet,
} from './types';
import {
  ADJUDICATION_LINE_PATTERN,
  CLAIM_HEADING_PATTERN,
  NOTE_LINE_PATTERN,
} from './worksheet-format';

const ADJUDICATION_VALUES: readonly Adjudication[] = ['correct_catch', 'false_catch'];

function isAdjudication(value: string): value is Adjudication {
  return (ADJUDICATION_VALUES as readonly string[]).includes(value);
}

interface Section {
  claimId: string;
  adjudication: Adjudication | null;
  note: string;
  adjudicationLineSeen: boolean;
}

/**
 * Reads a filled worksheet back into one row per claim section.
 *
 * Fails CLOSED per row rather than guessing: a value outside `correct_catch`/`false_catch`, a
 * repeated claim id, or a second adjudication line in one section becomes an entry in `errors`,
 * never a bucket assignment. An empty adjudication field is not an error — it is an unfilled row,
 * which {@link ParsedWorksheet}'s consumer refuses to score rather than counting either way.
 */
export function parseWorksheet(markdown: string): ParsedWorksheet {
  const rows: AdjudicationRow[] = [];
  const errors: AdjudicationParseError[] = [];
  const seenClaimIds = new Set<string>();
  let current: Section | undefined;

  const flush = (): void => {
    if (!current) {
      return;
    }
    rows.push({
      claimId: current.claimId,
      adjudication: current.adjudication,
      note: current.note,
    });
    current = undefined;
  };

  for (const line of markdown.split('\n')) {
    const heading = CLAIM_HEADING_PATTERN.exec(line);
    if (heading) {
      flush();
      const claimId = heading[1];
      if (seenClaimIds.has(claimId)) {
        errors.push({
          claimId,
          rawValue: line,
          message: `claim ${claimId} appears in more than one section`,
        });
        continue;
      }
      seenClaimIds.add(claimId);
      current = { claimId, adjudication: null, note: '', adjudicationLineSeen: false };
      continue;
    }

    if (!current) {
      continue;
    }

    const adjudication = ADJUDICATION_LINE_PATTERN.exec(line);
    if (adjudication) {
      if (current.adjudicationLineSeen) {
        errors.push({
          claimId: current.claimId,
          rawValue: line,
          message: `claim ${current.claimId} has more than one adjudication line`,
        });
        continue;
      }
      current.adjudicationLineSeen = true;
      const raw = adjudication[1].trim().replace(/^`|`$/g, '').trim();
      if (raw.length === 0) {
        continue;
      }
      if (!isAdjudication(raw)) {
        errors.push({
          claimId: current.claimId,
          rawValue: raw,
          message: `claim ${current.claimId}: '${raw}' is not ${ADJUDICATION_VALUES.join(' or ')}`,
        });
        continue;
      }
      current.adjudication = raw;
      continue;
    }

    const note = NOTE_LINE_PATTERN.exec(line);
    if (note) {
      current.note = note[1].trim();
    }
  }

  flush();
  return { rows, errors };
}
