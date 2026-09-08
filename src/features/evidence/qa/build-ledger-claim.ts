import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type {
  FactKey,
  FactValue,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { locateQuote } from '../../../shared/utils/locate-quote.util';
import { checkQuoteAlignment } from './check-quote-alignment';
import type { Claim } from './contracts/answer.contract';
import { containsUnrepresentableNumber, extractNumericTokens } from './extract-numeric-tokens';

/** `citationSchema.quote`'s own cap (`contracts/answer.contract.ts`) — never a length this module
 *  can hand back a longer quote than. */
const MAX_QUOTE_LENGTH = 300;

export interface LedgerClaimFact {
  readonly factKey: FactKey;
  readonly value: FactValue;
  readonly rawText: string;
  readonly chunkId: string;
  readonly documentVersionId: string;
  readonly locator: EvidenceLocator;
}

export interface LedgerClaimInput {
  readonly fact: LedgerClaimFact;
  readonly chunkText: string;
  readonly sha256: string;
  readonly entityLabel: string;
  readonly measureLabel: string;
}

/** The `MAX_QUOTE_LENGTH`-character window of `line` that contains `rawText`'s own position,
 *  centered on it where `line` is long enough to allow that; `line`'s own first
 *  `MAX_QUOTE_LENGTH` characters when `rawText` cannot be found in it verbatim. */
function windowContaining(line: string, rawText: string): string {
  const matchIndex = line.indexOf(rawText);
  if (matchIndex === -1) {
    return line.slice(0, MAX_QUOTE_LENGTH);
  }
  const halfWindow = Math.floor((MAX_QUOTE_LENGTH - rawText.length) / 2);
  const start = Math.max(0, Math.min(matchIndex - halfWindow, line.length - MAX_QUOTE_LENGTH));
  return line.slice(start, start + MAX_QUOTE_LENGTH);
}

/**
 * Renders one ledger fact into the single claim a ledger-first answer stands on, or `null` when
 * the rendered statement or its quote cannot clear the same checks `verifyClaim` runs against a
 * synthesized claim (numeric consistency, `locateQuote`, `checkQuoteAlignment`) — the caller
 * (`LedgerAnswerService`) treats `null` as unresolved, never as a degraded claim.
 *
 * `entityLabel`/`measureLabel`/`period` never appear as digits inside the rendered statement:
 * `fact.value.amount` (via `amountText`) is the statement's only number, and the check below
 * refuses a label that would smuggle in a second one — a proposed measure slug or period carrying
 * a digit would otherwise make `extractNumericTokens(statement)` disagree with `amountText`, and
 * the check4 numeric-support gate a synthesized claim faces treats every extra digit as an
 * obligation to support.
 */
export function buildLedgerClaim(input: LedgerClaimInput): Claim | null {
  const { fact, chunkText, sha256, entityLabel, measureLabel } = input;

  const rawTextTokens = extractNumericTokens(fact.rawText);
  const amountText =
    fact.locator.kind === 'xlsx-cell'
      ? String(fact.value.amount)
      : rawTextTokens.length === 1
        ? String(rawTextTokens[0])
        : String(fact.value.amount);

  const statement = `${entityLabel}: ${measureLabel} is ${amountText} ${fact.value.unit}.`;

  if (containsUnrepresentableNumber(statement)) {
    return null;
  }
  const statementNumbers = extractNumericTokens(statement);
  if (statementNumbers.length !== 1 || statementNumbers[0] !== Number(amountText)) {
    return null;
  }

  const matchingLine = chunkText
    .split('\n')
    .find((line) => locateQuote(fact.rawText, line).kind === 'exact');
  const candidateQuote = matchingLine ?? fact.rawText;
  const quote =
    candidateQuote.length > MAX_QUOTE_LENGTH
      ? windowContaining(candidateQuote, fact.rawText)
      : candidateQuote;

  if (locateQuote(quote, chunkText).kind !== 'exact') {
    return null;
  }

  const corroboratedNumericTokens =
    fact.locator.kind === 'xlsx-cell' ? new Set([fact.value.amount]) : new Set<number>();
  const alignment = checkQuoteAlignment({ statement, quotes: [quote], corroboratedNumericTokens });
  if (alignment.kind !== 'aligned') {
    return null;
  }

  return {
    statement,
    citations: [
      {
        docVersionId: fact.documentVersionId,
        sha256,
        chunkId: fact.chunkId,
        locator: fact.locator,
        quote,
      },
    ],
  };
}
