import type { XbrlConcept } from './xbrl-concepts';

export interface RenderedForm {
  readonly text: string;
  readonly scale: 1 | 1e3 | 1e6;
}

/** Thousands-separated integer, sign expressed as `(1,234)` rather than `-1,234` — the convention
 *  every candidate registrant's own filings use for a negative figure, so a rendered form matches
 *  what the document actually prints rather than a machine-formatted negative. Never a trailing
 *  `.0` — the value is rounded to an integer before formatting, not truncated to one decimal. */
function formatInteger(value: number): string {
  const rounded = Math.round(value);
  const formatted = Math.abs(rounded).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return rounded < 0 ? `(${formatted})` : formatted;
}

function formatFixed2(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const formatted = Math.abs(rounded).toFixed(2);
  return rounded < 0 ? `(${formatted})` : formatted;
}

const CURRENCY_SCALES: readonly (1 | 1e3 | 1e6)[] = [1, 1e3, 1e6];

/**
 * Every plausible rendering of an XBRL fact's raw `val`, for `locateValue` to search a document's
 * text for. A currency value renders at all three scales a filer might state it at (full dollars,
 * thousands, millions) — a REIT's prose is as likely to say "$1.2 billion" in thousands or millions
 * as in full dollars. Per-share and count/area values have exactly one scale; a share count or a
 * square-footage figure is never restated at a different scale within a filing.
 */
export function renderedForms(
  val: number,
  valueType: XbrlConcept['valueType'],
): readonly RenderedForm[] {
  if (valueType === 'per-share') {
    return [{ text: formatFixed2(val), scale: 1 }];
  }

  if (valueType !== 'currency') {
    // count | area
    return [{ text: formatInteger(val), scale: 1 }];
  }

  const forms: RenderedForm[] = [];
  const seenText = new Set<string>();
  for (const scale of CURRENCY_SCALES) {
    const text = formatInteger(val / scale);
    if (seenText.has(text)) {
      continue;
    }
    seenText.add(text);
    forms.push({ text, scale });
  }
  return forms;
}
