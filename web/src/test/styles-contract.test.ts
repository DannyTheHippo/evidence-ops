/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
// Depends on `test.css.include` covering `src/styles/` in `web/vite.config.ts`. Vitest's
// `vitest:css-disable` plugin stubs every module whose id matches `.css` — `?raw` and `?inline`
// alike — to `export default ''` at a `pre` transform stage that runs before Vite's own query
// handling, unless `test.css` opts that id in (see `cssEnabler.ts`'s `shouldProcessCSS`). Narrowing
// the opt-in to `src/styles/` keeps the cheaper stub for every other test. `main.tsx` is not a
// `.css` id, so its `?raw` import is unaffected either way.
import tokensCss from '../styles/tokens.css?raw';
import baseCss from '../styles/base.css?raw';
import primitivesCss from '../styles/primitives.css?raw';
import shellCss from '../styles/shell.css?raw';
import railCss from '../styles/rail.css?raw';
import viewsCss from '../styles/views.css?raw';
import mainTsx from '../main.tsx?raw';

/**
 * Guards the token register in `tokens.css` against the six stylesheets drifting back to literal
 * values. Every check here fails CLOSED: a `?raw` import that resolves to an empty string, a
 * selector this file's regex-based rule extraction cannot locate, or a sweep that stops matching
 * anything all raise an assertion failure rather than letting the surrounding `it` pass over an
 * empty comparison — a contract test that can pass vacuously would certify a property it never
 * actually checked.
 *
 * Bare pixel sizing (`height`/`padding`/`font-size` outside `tokens.css`) is resolved two ways,
 * chosen per declaration: a genuine control dimension is tokenized (`.topbar`'s height moved to
 * `--topbar-height`, alongside `--ledger-bar-height`'s existing precedent for a one-off pixel
 * constant with no better home), while five decorative marker/utility sizes are left as bare
 * pixels and carried in the explicit, selector-scoped `BARE_HEIGHT_EXEMPTIONS` list below instead —
 * tokenizing a "7px dot" buys nothing when the number is never reused or reasoned about elsewhere.
 * Two of the five (`.sr-only`, `.badge::before`) were already bare before this change; the other
 * three (`.brand-mark`, `.theme-toggle > span`, `.live-dot`) are the same species of decorative
 * marker but were not caught by the F0b pass — this test is what now holds all five in place, and
 * a sixth marker joining them must earn its own line in the list rather than being caught by a
 * loose value match.
 */

interface Stylesheet {
  file: string;
  css: string;
}

const NON_TOKEN_SHEETS: readonly Stylesheet[] = [
  { file: 'base.css', css: baseCss },
  { file: 'primitives.css', css: primitivesCss },
  { file: 'shell.css', css: shellCss },
  { file: 'rail.css', css: railCss },
  { file: 'views.css', css: viewsCss },
];

const ALL_SHEETS: readonly Stylesheet[] = [
  { file: 'tokens.css', css: tokensCss },
  ...NON_TOKEN_SHEETS,
];

const ALLOWED_BREAKPOINTS = new Set([560, 767, 1023]);

type BareSizeProperty = 'height' | 'padding' | 'font-size';

interface BareSizeExemption {
  file: string;
  selector: string;
  property: BareSizeProperty;
}

/** Selector-scoped, not value-scoped: a new selector reusing e.g. "7px" for something that is not
 * one of these five markers is still caught. */
const BARE_HEIGHT_EXEMPTIONS: readonly BareSizeExemption[] = [
  { file: 'primitives.css', selector: '.sr-only', property: 'height' },
  { file: 'primitives.css', selector: '.badge::before', property: 'height' },
  { file: 'shell.css', selector: '.brand-mark', property: 'height' },
  { file: 'shell.css', selector: '.theme-toggle > span', property: 'height' },
  { file: 'views.css', selector: '.live-dot', property: 'height' },
];

/** Comments can mention "@media", a property name, or a px value in prose (e.g. primitives.css's
 * print-page-box paragraph) without being a real rule; every sweep below runs against
 * comment-stripped text so prose never masquerades as a declaration. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractRuleBlocks(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

function isExemptHeight(file: string, selector: string): boolean {
  return BARE_HEIGHT_EXEMPTIONS.some(
    (exemption) =>
      exemption.file === file && exemption.selector === selector && exemption.property === 'height',
  );
}

describe('styles contract', () => {
  it.each(ALL_SHEETS)('$file loads as non-empty raw text', ({ file, css }) => {
    expect(css.length, `${file} resolved to an empty string via the ?raw import`).toBeGreaterThan(
      0,
    );
  });

  it('records only the three registered breakpoints inside @media preludes', () => {
    let occurrences = 0;
    for (const { file, css } of ALL_SHEETS) {
      const stripped = stripComments(css);
      const preludes = [...stripped.matchAll(/@media\s+([^{]+)\{/g)].map((match) => match[1]);
      for (const prelude of preludes) {
        for (const [, raw] of prelude.matchAll(/(?:min|max)-width\s*:\s*(\d+)px/g)) {
          occurrences += 1;
          const value = Number(raw);
          expect(
            ALLOWED_BREAKPOINTS.has(value),
            `${file}: @media prelude uses ${value}px, not one of 560/767/1023`,
          ).toBe(true);
        }
      }
    }
    // Canary against a regex that silently stops matching: today's six stylesheets carry seven
    // min-/max-width occurrences inside @media preludes (primitives.css x2, shell.css x3,
    // rail.css x1, views.css x1). A future breakpoint use can only raise this floor.
    expect(occurrences).toBeGreaterThanOrEqual(7);
  });

  it('never uses a raw z-index literal outside tokens.css', () => {
    let occurrences = 0;
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      for (const [, value] of stripped.matchAll(/z-index\s*:\s*([^;]+);/g)) {
        occurrences += 1;
        expect(
          value.trim(),
          `${file}: z-index must read a var(--z-*) token, found "${value.trim()}"`,
        ).toMatch(/^var\(--z-[\w-]+\)$/);
      }
    }
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });

  it('never uses a hex/rgb/hsl colour literal outside tokens.css', () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      expect(literal.test(stripped), `${file}: found a hex/rgb/hsl colour literal`).toBe(false);
    }
  });

  it('keeps height/padding/font-size off bare pixels outside tokens.css, save the listed marker exemptions', () => {
    const propertyPattern = /(?<![\w-])(height|padding(?:-[a-z]+)?|font-size)\s*:\s*([^;]+);/g;
    let occurrences = 0;
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      for (const { selector, body } of extractRuleBlocks(stripped)) {
        for (const [, property, value] of body.matchAll(propertyPattern)) {
          if (!/\d+(?:\.\d+)?px/.test(value)) continue;
          occurrences += 1;
          const canonical: BareSizeProperty =
            property === 'height'
              ? 'height'
              : property.startsWith('padding')
                ? 'padding'
                : 'font-size';
          const allowed = canonical === 'height' && isExemptHeight(file, selector);
          expect(
            allowed,
            `${file} "${selector}" sets ${property}: ${value.trim()} in bare px — move it to a token, or add it to BARE_HEIGHT_EXEMPTIONS if it is a decorative marker size`,
          ).toBe(true);
        }
      }
    }
    // Canary: today's five exemptions (sr-only, badge::before, brand-mark, theme-toggle > span,
    // live-dot) are the only bare-px height/padding/font-size declarations left outside tokens.css.
    expect(occurrences).toBe(5);
  });

  it('keeps both dark-theme token blocks in tokens.css identical ignoring indentation', () => {
    const stripped = stripComments(tokensCss);
    const firstBody = extractRuleBody(stripped, ":root:not([data-theme='light'])");
    const secondBody = extractRuleBody(stripped, ":root[data-theme='dark']");
    expect(normalizeBody(firstBody)).toEqual(normalizeBody(secondBody));
    // Guard the comparison itself: two empty strings would also be "equal".
    expect(normalizeBody(firstBody).length).toBeGreaterThan(0);
  });

  it('imports the six stylesheets from main.tsx in cascade order', () => {
    const imported = [...mainTsx.matchAll(/import '\.\/styles\/([\w.-]+)';/g)].map(
      (match) => match[1],
    );
    expect(imported).toEqual([
      'tokens.css',
      'base.css',
      'primitives.css',
      'shell.css',
      'rail.css',
      'views.css',
    ]);
  });
});

function extractRuleBody(css: string, selector: string): string {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  expect(start, `could not locate "${marker}" in tokens.css`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const bodyEnd = css.indexOf('}', bodyStart);
  expect(
    bodyEnd,
    `could not find the closing brace for "${selector}" in tokens.css`,
  ).toBeGreaterThan(bodyStart);
  return css.slice(bodyStart, bodyEnd);
}

function normalizeBody(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
