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
import featuresCss from '../styles/features.css?raw';
import printCss from '../styles/print.css?raw';
import mainTsx from '../main.tsx?raw';

/**
 * Guards the token register in `tokens.css` against the seven stylesheets drifting back to literal
 * values. Every check here fails CLOSED: a `?raw` import that resolves to an empty string, a
 * selector this file's regex-based rule extraction cannot locate, or a sweep that stops matching
 * anything all raise an assertion failure rather than letting the surrounding `it` pass over an
 * empty comparison — a contract test that can pass vacuously would certify a property it never
 * actually checked.
 *
 * Bare pixel sizing (`height`/`padding`/`font-size` outside `tokens.css`) is resolved two ways,
 * chosen per declaration: a genuine control dimension is tokenized (`.topbar`'s height moved to
 * `--topbar-height`, alongside `--ledger-bar-height`'s existing precedent for a one-off pixel
 * constant with no better home), while four decorative marker sizes are left as bare pixels and
 * carried in the explicit, selector-scoped `BARE_HEIGHT_EXEMPTIONS` list below instead —
 * tokenizing a "7px dot" buys nothing when the number is never reused or reasoned about elsewhere.
 * `.sr-only` and `.badge::before` live in `primitives.css`; `.brand-mark` lives in `shell.css`;
 * `.live-dot` lives in `primitives.css` beside a generic marker's other consumers rather than a
 * single feature. A fifth marker joining them must earn its own line in the list rather than being
 * caught by a loose value match.
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
  { file: 'features.css', css: featuresCss },
  { file: 'print.css', css: printCss },
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
 * one of these four markers is still caught. */
const BARE_HEIGHT_EXEMPTIONS: readonly BareSizeExemption[] = [
  { file: 'primitives.css', selector: '.sr-only', property: 'height' },
  { file: 'primitives.css', selector: '.badge::before', property: 'height' },
  { file: 'shell.css', selector: '.brand-mark', property: 'height' },
  { file: 'primitives.css', selector: '.live-dot', property: 'height' },
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
    // Canary against a regex that silently stops matching. A floor, not an exact count: the
    // allowed-breakpoint assertion above is the gate, and the min-/max-width @media preludes across
    // primitives.css, shell.css, rail.css, views.css and features.css are free to raise it.
    expect(occurrences).toBeGreaterThanOrEqual(9);
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
          // Scoped to bare *pixel* values only. A tokenized height/padding/font-size resolves to
          // a rem (var(--space-4) is 1rem, not a px literal in the sheet text), so widening this
          // match to catch rem would fail every legitimately tokenized declaration, not just the
          // untokenized ones the sweep exists to catch.
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
    // Canary: the four exemptions above (sr-only, badge::before, brand-mark, live-dot) are the only
    // bare-px height/padding/font-size declarations outside tokens.css. Exact, not a floor: here the
    // count is part of the gate, because the exemption list is selector-scoped — a new decorative
    // marker must earn both a list entry and a bump to this number in the same change.
    expect(occurrences).toBe(4);
  });

  it('keeps both dark-theme token blocks in tokens.css identical ignoring indentation', () => {
    const stripped = stripComments(tokensCss);
    const firstBody = extractRuleBody(stripped, ":root:not([data-theme='light'])");
    const secondBody = extractRuleBody(stripped, ":root[data-theme='dark']");
    expect(normalizeBody(firstBody)).toEqual(normalizeBody(secondBody));
    // Guard the comparison itself: two empty strings would also be "equal".
    expect(normalizeBody(firstBody).length).toBeGreaterThan(0);
  });

  it('tokenizes transition-duration and animation-duration outside tokens.css, save the reduced-motion kill switch', () => {
    // The transition-duration/animation-duration longhands only — followed by a hyphen rather than
    // a colon, so this never overlaps with the transition/animation shorthand check below.
    const durationPattern = /\b(transition-duration|animation-duration)\s*:\s*([^;]+);/g;
    const nearZero = /^0(?:\.\d+)?m?s\b/;
    let occurrences = 0;
    let exempt = 0;
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      for (const [, property, rawValue] of stripped.matchAll(durationPattern)) {
        occurrences += 1;
        const value = rawValue.trim();
        if (nearZero.test(value)) {
          exempt += 1;
          continue;
        }
        expect(
          value,
          `${file}: ${property} must read a var(--motion-*) token, found "${value}"`,
        ).toMatch(/^var\(--motion-[\w-]+\)$/);
      }
    }
    // Canary against a regex that silently stops matching. It is a floor, not an exact count: the
    // rule above is the gate, and a new tokenized longhand must be free to raise this number. The
    // two longhands present are base.css's reduced-motion kill switch, exempt as a near-zero
    // override rather than a tokenized duration.
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(exempt).toBeGreaterThanOrEqual(2);
  });

  it('tokenizes every duration inside a transition/animation shorthand outside tokens.css', () => {
    // Property-name boundary requires a colon directly after "transition"/"animation", so this
    // never overlaps with the -duration longhands checked above. A shorthand can list several
    // comma-separated properties (each carrying its own duration) and may itself span lines, hence
    // the non-greedy [\s\S]*? rather than [^;]+. Easing keywords (ease-out, ease-in-out, …) are
    // deliberately out of scope — only the numeric time components are swept and required to
    // originate from a var(--motion-*) reference; a bare literal survives everywhere else in the
    // value (property names, "infinite", commas) because those never match the time pattern.
    const shorthandPattern = /\b(transition|animation)\s*:\s*([\s\S]*?);/g;
    const motionVarPattern = /var\(--motion-[\w-]+\)/g;
    const timePattern = /\d+(?:\.\d+)?m?s\b/g;
    let declarations = 0;
    let tokenizedTimes = 0;
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      for (const [, property, rawValue] of stripped.matchAll(shorthandPattern)) {
        declarations += 1;
        const value = rawValue.trim();
        tokenizedTimes += value.match(motionVarPattern)?.length ?? 0;
        const bareTimes = value.replace(motionVarPattern, '').match(timePattern) ?? [];
        for (const bare of bareTimes) {
          expect(
            false,
            `${file}: ${property} shorthand carries a bare duration "${bare}" — every time ` +
              `component in a transition/animation shorthand must read a var(--motion-*) token`,
          ).toBe(true);
        }
      }
    }
    // Canary against a regex that silently stops matching. Floors, not exact counts: the bare-time
    // assertion above is the gate, and every new animation the interface grows must be free to
    // raise both numbers. Some declarations list more than one transitioned property, which is why
    // tokenized times outnumber declarations.
    expect(declarations).toBeGreaterThanOrEqual(11);
    expect(tokenizedTimes).toBeGreaterThanOrEqual(14);
  });

  it('tokenizes font-family outside tokens.css', () => {
    const fontPattern = /font-family\s*:\s*([^;]+);/g;
    let occurrences = 0;
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      for (const [, rawValue] of stripped.matchAll(fontPattern)) {
        occurrences += 1;
        const value = rawValue.trim();
        expect(
          value,
          `${file}: font-family must read a var(--font-*) token, or inherit one from an ancestor ` +
            `that does, found "${value}"`,
        ).toMatch(/^var\(--font-[\w-]+\)$|^inherit$/);
      }
    }
    // Canary against a regex that silently stops matching. A floor, not an exact count: the rule
    // above is the gate. The declarations present split between a var(--font-*) token and a control
    // inheriting the ancestor stack rather than restating it.
    expect(occurrences).toBeGreaterThanOrEqual(12);
  });

  it('keeps --control-h-sm at or above the WCAG 2.2 (2.5.8) minimum target dimension', () => {
    const stripped = stripComments(tokensCss);
    const match = stripped.match(/--control-h-sm:\s*(\d+(?:\.\d+)?)px/);
    expect(match, 'could not locate "--control-h-sm: NNpx" in tokens.css').not.toBeNull();
    const value = Number(match![1]);
    expect(
      value,
      `--control-h-sm is ${value}px, below the 24px minimum target dimension`,
    ).toBeGreaterThanOrEqual(24);
  });

  it('imports the eight stylesheets from main.tsx in cascade order', () => {
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
      'features.css',
      'print.css',
    ]);
  });

  it('keeps print.css last of the main.tsx style imports', () => {
    const imported = [...mainTsx.matchAll(/import '\.\/styles\/([\w.-]+)';/g)].map(
      (match) => match[1],
    );
    // print.css's @media print block overrides an unconditional rule from every earlier
    // stylesheet and carries no specificity of its own, so it only wins the cascade by sitting
    // last; an import reordered ahead of it would silently drop every print override.
    expect(imported.at(-1)).toBe('print.css');
  });

  it('pins the toolbar contract', () => {
    // No toolbar-scoped rule may also target a hint: format instructions belong in the
    // placeholder or a visually-hidden aria-describedby element, never a toolbar hint span.
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      for (const { selector } of extractRuleBlocks(stripped)) {
        const parts = selector.split(',').map((part) => part.trim());
        if (!parts.some((part) => part.includes('.toolbar'))) continue;
        expect(
          parts.some((part) => part.includes('.hint')),
          `${file}: "${selector}" combines .toolbar with .hint`,
        ).toBe(false);
      }
    }

    // The filter row wraps its controls onto shared bottom edges; a grid template here collapses a
    // toolbar's filters into one column.
    const filterBarBody = findRuleBody(primitivesCss, '.filter-bar');
    expect(filterBarBody).toMatch(/display\s*:\s*flex\s*;/);
    expect(filterBarBody).toMatch(/flex-wrap\s*:\s*wrap\s*;/);
    expect(filterBarBody).toMatch(/align-items\s*:\s*flex-end\s*;/);
    expect(filterBarBody).not.toMatch(/grid-template-columns\s*:/);

    expect(findRuleBody(primitivesCss, '.toolbar-row--view')).toMatch(
      /align-items\s*:\s*center\s*;/,
    );
    // The toolbar's row gap spaces the view switch; a margin of its own would double it.
    expect(findRuleBody(primitivesCss, '.segmented-control')).not.toMatch(
      /(?<![\w-])margin(?:-[a-z-]+)?\s*:/,
    );

    let ruleCount = 0;
    for (const { file, css } of ALL_SHEETS) {
      for (const { selector } of extractRuleBlocks(stripComments(css))) {
        ruleCount += 1;
        expect(
          /\.toolbar-(?:start|actions)(?![\w-])/.test(selector),
          `${file}: "${selector}" targets a toolbar slot Toolbar no longer renders`,
        ).toBe(false);
      }
    }
    expect(ruleCount).toBeGreaterThan(0);
  });

  it('pins the form grid', () => {
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      for (const { selector } of extractRuleBlocks(stripped)) {
        const parts = selector.split(',').map((part) => part.trim());
        expect(parts.includes('.form label'), `${file}: ".form label" must not exist`).toBe(false);
      }
    }

    const widthPattern = /(?<![\w-])(width|min-width)\s*:\s*([^;]+);/g;
    let occurrences = 0;
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      for (const { selector, body } of extractRuleBlocks(stripped)) {
        const parts = selector.split(',').map((part) => part.trim());
        if (!parts.some((part) => part.startsWith('.field'))) continue;
        for (const [, property, rawValue] of body.matchAll(widthPattern)) {
          occurrences += 1;
          const value = rawValue.trim();
          expect(
            value === '100%' || /^var\(--control-w-(sm|md|lg)\)$/.test(value),
            `${file}: "${selector}" sets ${property}: ${value} — a field width must read a var(--control-w-*) token or 100%`,
          ).toBe(true);
        }
      }
    }
    expect(occurrences).toBeGreaterThanOrEqual(3);

    // A field width is a minimum on the wrapper, so a select sizes to its longest option.
    for (const size of ['sm', 'md', 'lg']) {
      expect(findRuleBody(primitivesCss, `.field--${size}`)).toMatch(
        new RegExp(`min-width\\s*:\\s*var\\(--control-w-${size}\\)\\s*;`),
      );
    }
    const growBody = findRuleBody(primitivesCss, '.field--grow');
    expect(growBody).toMatch(/flex\s*:\s*1 1 var\(--control-w-md\)\s*;/);
    expect(growBody).toMatch(/max-width\s*:\s*var\(--control-w-lg\)\s*;/);
  });

  it('pins the control boundary token', () => {
    const boundaryPattern = /\b(border|border-color)\s*:\s*([^;]+);/g;
    const restingRules: { file: string; css: string; selector: string }[] = [
      {
        file: 'primitives.css',
        css: primitivesCss,
        selector: '.field input, .field textarea, .select',
      },
      { file: 'features.css', css: featuresCss, selector: '.composer-input' },
    ];
    let occurrences = 0;
    for (const { file, css, selector } of restingRules) {
      const body = findRuleBody(css, selector);
      for (const [, property, rawValue] of body.matchAll(boundaryPattern)) {
        occurrences += 1;
        expect(
          rawValue.trim(),
          `${file}: "${selector}" resting ${property} is "${rawValue.trim()}", not var(--control-line)`,
        ).toMatch(/var\(--control-line\)$/);
      }
    }
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('pins the table row contract', () => {
    expect(findRuleBody(primitivesCss, '.grid tbody td')).toMatch(
      /height\s*:\s*var\(--row-h\)\s*;/,
    );

    const heightPattern = /(?<![\w-])height\s*:\s*([^;]+);/g;
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      for (const { selector, body } of extractRuleBlocks(stripped)) {
        if (!selector.includes('.grid')) continue;
        for (const [, rawValue] of body.matchAll(heightPattern)) {
          expect(
            /\d+(?:\.\d+)?px/.test(rawValue),
            `${file}: "${selector}" sets a bare-px height: ${rawValue.trim()}`,
          ).toBe(false);
        }
      }
    }
  });

  it('pins the page head grid', () => {
    expect(findRuleBody(viewsCss, '.page-head')).toMatch(/display\s*:\s*grid\s*;/);
    // .page-head-actions carries no pinned declaration of its own — only its existence, so the
    // wrapper .page-head's two-column grid always resolves against exactly two children.
    expect(findRuleBody(viewsCss, '.page-head-actions').length).toBeGreaterThan(0);
    // Only the grid is pinned, not its auto-fit template: a straight 1fr auto would pair the four
    // Stat children each live stat row renders into alternating wide and narrow rows.
    expect(findRuleBody(primitivesCss, '.stat-row')).toMatch(/display\s*:\s*grid\s*;/);
  });

  it('stacks the page head at <=560px with actions start-aligned and wrapping', () => {
    // .page-head and .page-head-actions each carry a second rule inside the narrow-width query;
    // extractRuleBlocks flattens nested @media rules alongside the unqueried ones (see the
    // breakpoint sweep above), so both rules for the same selector show up as separate blocks in
    // source order — the second is the narrow-width one.
    const blocks = extractRuleBlocks(stripComments(viewsCss));
    const pageHeadBlocks = blocks.filter((block) => block.selector === '.page-head');
    const actionsBlocks = blocks.filter((block) => block.selector === '.page-head-actions');
    expect(pageHeadBlocks).toHaveLength(2);
    expect(pageHeadBlocks[1].body).toMatch(/grid-template-columns\s*:\s*1fr\s*;/);
    expect(actionsBlocks).toHaveLength(2);
    expect(actionsBlocks[1].body).toMatch(/flex-wrap\s*:\s*wrap\s*;/);
    expect(actionsBlocks[1].body).toMatch(/justify-self\s*:\s*start\s*;/);
  });

  it("never zeros a top-layer element's own top margin after the page head", () => {
    expect(findRuleBody(viewsCss, '.page-head + *:not(dialog):not([popover])')).toMatch(
      /margin-top\s*:\s*0\s*;/,
    );

    // The `+` combinator only evaluates against a real previous element sibling, so each case
    // below builds one rather than asserting on a detached node.
    const parent = document.createElement('div');
    const pageHead = parent.appendChild(document.createElement('div'));
    pageHead.className = 'page-head';

    const dialog = parent.appendChild(document.createElement('dialog'));
    expect(dialog.matches('.page-head + *:not(dialog):not([popover])')).toBe(false);
    parent.removeChild(dialog);

    const popoverDiv = parent.appendChild(document.createElement('div'));
    popoverDiv.setAttribute('popover', '');
    expect(popoverDiv.matches('.page-head + *:not(dialog):not([popover])')).toBe(false);
    parent.removeChild(popoverDiv);

    // An in-flow follower — a `.toolbar` or `.card` — still gets its top margin zeroed.
    const card = parent.appendChild(document.createElement('div'));
    card.className = 'card';
    expect(card.matches('.page-head + *:not(dialog):not([popover])')).toBe(true);
  });

  it.each([
    { name: 'breadcrumb-ellipsis', selector: '.breadcrumb li.breadcrumb-ellipsis' },
    { name: 'breadcrumb-collapse', selector: '.breadcrumb li.breadcrumb-collapse' },
  ])('out-ranks ".breadcrumb li" with its $name display rule', ({ selector }) => {
    const liSpecificity = specificity('.breadcrumb li');
    const challengerSpecificity = specificity(selector);
    const firstDifference = challengerSpecificity.findIndex(
      (count, i) => count !== liSpecificity[i],
    );
    expect(
      firstDifference >= 0 &&
        challengerSpecificity[firstDifference] > liSpecificity[firstDifference],
      `"${selector}" (${challengerSpecificity.join(',')}) must out-rank ".breadcrumb li" (${liSpecificity.join(',')})`,
    ).toBe(true);
  });

  it('shows the breadcrumb ellipsis only in place of the crumbs it collapses', () => {
    const blocks = extractRuleBlocks(stripComments(shellCss));
    const ellipsisBlocks = blocks.filter(
      (block) => block.selector === '.breadcrumb li.breadcrumb-ellipsis',
    );
    const collapseBlocks = blocks.filter(
      (block) => block.selector === '.breadcrumb li.breadcrumb-collapse',
    );
    expect(ellipsisBlocks).toHaveLength(2);
    expect(ellipsisBlocks[0].body).toMatch(/display\s*:\s*none\s*;/);
    expect(ellipsisBlocks[1].body).toMatch(/display\s*:\s*flex\s*;/);
    expect(collapseBlocks).toHaveLength(1);
    expect(collapseBlocks[0].body).toMatch(/display\s*:\s*none\s*;/);

    // Ancestor crumbs (a link or plain text, never the current page) truncate within their own
    // shrunk li instead of overflowing it and painting over the next crumb.
    const ancestorBody = findRuleBody(
      shellCss,
      '.breadcrumb li > a, .breadcrumb li > span:not(.breadcrumb-sep):not(.breadcrumb-current)',
    );
    expect(ancestorBody).toMatch(/overflow\s*:\s*hidden\s*;/);
    expect(ancestorBody).toMatch(/text-overflow\s*:\s*ellipsis\s*;/);
    expect(ancestorBody).toMatch(/min-width\s*:\s*0\s*;/);
  });

  // jsdom lays out nothing, so none of the three checks below can see a chip or a segment
  // actually stop clipping at 375px — that's the browser re-walk's job. What these pin is the
  // mechanism: the flex items that must be able to shrink past their content width, and the one
  // label-span rule that does the truncating once they do.
  it('caps an example chip to its row width', () => {
    const chipBody = findRuleBody(primitivesCss, '.example-chip');
    expect(chipBody).toMatch(/max-width\s*:\s*100%\s*;/);
    // The ellipsis lives on `.btn-label` inside it; `.example-chip` itself is `inline-flex`
    // (via `.btn`), where `text-overflow` would never engage.
    expect(chipBody).not.toMatch(/text-overflow\s*:/);

    expect(findRuleBody(featuresCss, '.composer-examples')).toMatch(/min-width\s*:\s*0\s*;/);
  });

  it('keeps a SegmentedControl to one row at every width', () => {
    const groupBody = findRuleBody(primitivesCss, '.segmented-control');
    expect(groupBody).toMatch(/flex-wrap\s*:\s*nowrap\s*;/);
    expect(groupBody).toMatch(/min-width\s*:\s*0\s*;/);

    const segmentBody = findRuleBody(primitivesCss, '.segmented-control > .btn');
    expect(segmentBody).toMatch(/min-width\s*:\s*0\s*;/);
    expect(segmentBody).not.toMatch(/text-overflow\s*:/);
  });

  it('keeps a view-slot wrapper from holding the toolbar row open past its edge', () => {
    // Every direct child of the view row gets a shrink-to-fit floor, not only a bare
    // `.segmented-control` — a wrapper div around one (`.sources-segmented`, for instance) has
    // no min-width rule of its own otherwise.
    const rowChildBody = findRuleBody(primitivesCss, '.toolbar-row--view > *');
    expect(rowChildBody).toMatch(/min-width\s*:\s*0\s*;/);

    // At phone width, a wrapper standing in for a bare control in the view slot spans the row
    // the same way the bare control does.
    const wrapperBody = findRuleBody(
      primitivesCss,
      '.toolbar-row--view > :has(> .segmented-control)',
    );
    expect(wrapperBody).toMatch(/flex\s*:\s*1 1 100%\s*;/);
  });

  it('truncates a button label on its own span, not on .btn', () => {
    const labelBody = findRuleBody(primitivesCss, '.btn-label');
    expect(labelBody).toMatch(/min-width\s*:\s*0\s*;/);
    expect(labelBody).toMatch(/overflow\s*:\s*hidden\s*;/);
    expect(labelBody).toMatch(/text-overflow\s*:\s*ellipsis\s*;/);
    expect(labelBody).toMatch(/white-space\s*:\s*nowrap\s*;/);
  });

  it('pins the caps register', () => {
    const emLiteral = /letter-spacing\s*:\s*[\d.]+em\s*;/;

    const eyebrowBody = findRuleBody(baseCss, '.eyebrow');
    expect(eyebrowBody).toMatch(/letter-spacing\s*:\s*var\(--tracking-caps\)\s*;/);
    expect(eyebrowBody).not.toMatch(emLiteral);

    const microLabelBody = findRuleBody(
      primitivesCss,
      '.micro-label, .fault-eyebrow, .stat-row-label, .policy-strip-label, .description-term, .grid thead th, .grid:has(td[data-label]) tbody td[data-label]::before',
    );
    expect(microLabelBody).toMatch(/letter-spacing\s*:\s*var\(--tracking-caps\)\s*;/);
    expect(microLabelBody).not.toMatch(emLiteral);
  });

  it('keeps every focus-visible rule outline-capable under forced colours', () => {
    let found = 0;
    for (const { file, css } of NON_TOKEN_SHEETS) {
      const stripped = stripComments(css);
      const restoredSelectors = extractForcedColorsSelectors(stripped);
      for (const { selector, body } of extractRuleBlocks(stripped)) {
        const parts = selector.split(',').map((part) => part.trim().replace(/\s+/g, ' '));
        const focusVisibleParts = parts.filter((part) => part.includes(':focus-visible'));
        if (focusVisibleParts.length === 0) continue;
        found += 1;
        if (!/outline\s*:\s*none\s*;/.test(body)) continue;
        const restored = focusVisibleParts.some((part) => restoredSelectors.has(part));
        expect(
          restored,
          `${file}: "${selector}" declares outline: none with no forced-colors restore for its exact selector`,
        ).toBe(true);
      }
    }
    // Canary against a regex that silently stops matching.
    expect(found).toBeGreaterThanOrEqual(8);
  });

  it('pins the highlight token', () => {
    const highlightBody = findRuleBody(primitivesCss, '.search-highlight');
    expect(highlightBody).toMatch(/background\s*:\s*var\(--highlight\)\s*;/);
    expect(highlightBody).toMatch(/color\s*:\s*var\(--ink\)\s*;/);

    const selectionBody = findRuleBody(baseCss, '::selection');
    expect(selectionBody).toMatch(/background\s*:\s*var\(--highlight\)\s*;/);
    expect(selectionBody).toMatch(/color\s*:\s*var\(--ink\)\s*;/);
  });

  it('pins the new-primitive classes', () => {
    // Overlay surfaces: chrome (background/border/shadow) present, and each carries the
    // popover-attribute-scoped display toggle rather than being visible unconditionally.
    expect(findRuleBody(primitivesCss, '.tooltip-surface')).toMatch(
      /max-width\s*:\s*var\(--tooltip-w-max\)\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.tooltip-surface[popover]:popover-open')).toMatch(
      /display\s*:\s*block\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.popover-surface')).toMatch(
      /box-shadow\s*:\s*var\(--shadow-pop\)\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.popover-surface[popover]:popover-open')).toMatch(
      /display\s*:\s*flex\s*;/,
    );
    // Both axes the anchor path can clip on carry a fallback: a bottom-clipped surface flips
    // upward, a side-clipped one flips to its other edge, and a surface clipped on both flips both.
    expect(findRuleBody(primitivesCss, '.popover-surface[popover]')).toMatch(
      /position-try-fallbacks\s*:[^;]*flip-block[^;]*flip-inline[^;]*;/,
    );
    // .menu-surface draws no chrome of its own inside Popover's .popover-surface: it declares no
    // background and no box-shadow.
    const menuSurfaceBody = findRuleBody(primitivesCss, '.menu-surface');
    expect(menuSurfaceBody).not.toMatch(/background\s*:/);
    expect(menuSurfaceBody).not.toMatch(/box-shadow\s*:/);

    // Drawer: sized off the drawer-width tokens, never a bare-px, and dismissible without printing.
    expect(findRuleBody(primitivesCss, '.drawer--sm')).toMatch(
      /width\s*:\s*var\(--drawer-w-sm\)\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.drawer--md')).toMatch(
      /width\s*:\s*var\(--drawer-w-md\)\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.drawer--lg')).toMatch(
      /width\s*:\s*var\(--drawer-w-lg\)\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.dialog-head, .drawer-head')).toMatch(
      /justify-content\s*:\s*space-between\s*;/,
    );

    // Boolean controls, search/file inputs, the multi-select and the date-range custom row.
    expect(findRuleBody(primitivesCss, '.checkbox-mark')).toMatch(
      /border\s*:\s*1px solid var\(--control-line\)\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.search-input-clear')).toMatch(
      /position\s*:\s*absolute\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.file-input--dragging')).toMatch(
      /background\s*:\s*var\(--signal-soft\)\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.combobox-listbox')).toMatch(
      /z-index\s*:\s*var\(--z-popover\)\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.date-range-row')).toMatch(/display\s*:\s*flex\s*;/);

    // Alert: rejected carries the .error family's left accent; every tone still reads its status
    // token pair.
    expect(findRuleBody(primitivesCss, '.alert--rejected')).toMatch(
      /border-left\s*:\s*3px solid var\(--status-reject-ink\)\s*;/,
    );

    // Pager's page-size and jump controls, and Stat's prose register.
    expect(findRuleBody(primitivesCss, '.pager-jump input')).toMatch(
      /height\s*:\s*var\(--control-h-sm\)\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.stat-row-value--text')).toMatch(
      /font-size\s*:\s*var\(--text-base\)\s*;/,
    );

    expect(findRuleBody(primitivesCss, '.btn--busy')).toMatch(/cursor\s*:\s*progress\s*;/);

    // The icon button holds the minimum target width at a specificity that outranks the size
    // modifiers, and no .queue-item.is-active rule exists: a queue row's selected state is
    // .queue-item[aria-current='true'] in features.css.
    expect(findRuleBody(primitivesCss, '.btn.btn--icon')).toMatch(
      /min-width\s*:\s*var\(--target-min\)\s*;/,
    );
    for (const { selector } of extractRuleBlocks(stripComments(primitivesCss))) {
      const parts = selector.split(',').map((part) => part.trim());
      expect(
        parts.includes('.queue-item.is-active'),
        'the dead ".queue-item.is-active" rule must be removed, not merely unused',
      ).toBe(false);
    }

    // Overlay surfaces never print.
    const printBody = findRuleBody(
      printCss,
      '.skip-link, .sidebar, .topbar, .toast-stack, .tooltip-surface, .popover-surface, .drawer',
    );
    expect(printBody).toMatch(/display\s*:\s*none\s*;/);
  });

  const cellActionsGapSelector =
    '.grid td.cell-actions > :is(.btn, .menu, .cell-sub) ~ :is(.btn, .menu, .cell-sub)';

  it('pins the table cell-actions column', () => {
    // Keeps the actions cell on one line in an auto-layout table. A `<colgroup>` table sets it
    // back to `normal` (`.grid:has(colgroup) td.cell-actions`), because a fixed-layout column
    // cannot grow, so `nowrap` there would push a status note or sub-line out of the cell.
    expect(findRuleBody(primitivesCss, '.grid td.cell-actions')).toMatch(
      /white-space\s*:\s*nowrap\s*;/,
    );
    expect(findRuleBody(primitivesCss, '.grid:has(colgroup) td.cell-actions')).toMatch(
      /white-space\s*:\s*normal\s*;/,
    );
    // Buttons inside a `.form-actions` wrapper take this gap from the wrapper; the start gap below
    // reaches only children placed straight in the cell.
    expect(findRuleBody(primitivesCss, '.grid td.cell-actions .form-actions')).toMatch(
      /gap\s*:\s*var\(--space-2\)\s*;/,
    );
    // A button, menu or text note placed straight in the cell after an earlier one gets the same
    // gap; the parameterised check below pins which children the selector reaches.
    expect(findRuleBody(primitivesCss, cellActionsGapSelector)).toMatch(
      /margin-inline-start\s*:\s*var\(--space-2\)\s*;/,
    );
    // features.css loads after primitives.css and zeroes a cell note's margin, so the gap only
    // reaches a `.cell-sub` by out-ranking that rule on specificity.
    const cellSubSelector = '.grid td .cell-sub';
    expect(findRuleBody(featuresCss, cellSubSelector)).toMatch(/(?<![\w-])margin\s*:\s*0\s*;/);
    const gapSpecificity = specificity(cellActionsGapSelector);
    const cellSubSpecificity = specificity(cellSubSelector);
    expect(gapSpecificity).toEqual([0, 4, 1]);
    expect(cellSubSpecificity).toEqual([0, 2, 1]);
    const firstDifference = gapSpecificity.findIndex((count, i) => count !== cellSubSpecificity[i]);
    expect(
      firstDifference >= 0 && gapSpecificity[firstDifference] > cellSubSpecificity[firstDifference],
      `"${cellActionsGapSelector}" (${gapSpecificity.join(',')}) must out-rank "${cellSubSelector}" (${cellSubSpecificity.join(',')})`,
    ).toBe(true);
    // A menu trigger matches a small button's height, so its row still holds --row-h.
    expect(findRuleBody(primitivesCss, '.grid td.cell-actions .menu-trigger')).toMatch(
      /height\s*:\s*var\(--control-h-sm\)\s*;/,
    );
  });

  // One actions cell holding, straight inside it and in this order, the direct child types the
  // selector must include or exclude: a button, an open `Dialog`'s `<dialog>`, a button, a text
  // note, a menu and a row alert.
  it.each([
    { child: 'first button', index: 0, matches: false },
    { child: 'open dialog', index: 1, matches: false },
    { child: 'button after the open dialog', index: 2, matches: true },
    { child: 'text note', index: 3, matches: true },
    { child: 'menu', index: 4, matches: true },
    { child: 'row alert', index: 5, matches: false },
  ])('gives the cell-actions start gap to the $child: $matches', ({ index, matches }) => {
    const table = document.createElement('table');
    table.className = 'grid';
    const row = table
      .appendChild(document.createElement('tbody'))
      .appendChild(document.createElement('tr'));
    const cell = row.appendChild(document.createElement('td'));
    cell.className = 'cell-actions';
    const dialog = document.createElement('dialog');
    dialog.open = true;
    const children = [
      Object.assign(document.createElement('button'), { className: 'btn btn--secondary' }),
      dialog,
      Object.assign(document.createElement('button'), { className: 'btn btn--secondary' }),
      Object.assign(document.createElement('span'), { className: 'cell-sub' }),
      Object.assign(document.createElement('div'), { className: 'menu' }),
      Object.assign(document.createElement('div'), { className: 'alert alert--rejected' }),
    ];
    cell.append(...children);
    expect(children[index].matches(cellActionsGapSelector)).toBe(matches);
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

/** Collects every selector declared inside an `@media (forced-colors: active) { … }` block,
 * comma-list entries split apart, so a rule outside the query can be checked against exactly what
 * forced colours restore for it. Brace-depth aware, unlike `extractRuleBlocks`, because a nested
 * rule's own braces would otherwise stop a naive `indexOf('}')` short. */
function extractForcedColorsSelectors(strippedCss: string): Set<string> {
  const selectors = new Set<string>();
  const startPattern = /@media\s*\(\s*forced-colors:\s*active\s*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(strippedCss))) {
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < strippedCss.length && depth > 0) {
      if (strippedCss[i] === '{') depth += 1;
      else if (strippedCss[i] === '}') depth -= 1;
      i += 1;
    }
    const inner = strippedCss.slice(bodyStart, i - 1);
    for (const { selector } of extractRuleBlocks(inner)) {
      for (const part of selector.split(',')) {
        selectors.add(part.trim().replace(/\s+/g, ' '));
      }
    }
  }
  return selectors;
}

/** Locates a rule by its full, comma-joined selector list, tolerant of the selector's own line
 * breaks (unlike `extractRuleBody`'s literal `indexOf`, which only matches a single-line
 * selector). Fails CLOSED: an unmatched selector raises rather than returning an empty body. */
function findRuleBody(css: string, exactSelector: string): string {
  const stripped = stripComments(css);
  const normalize = (selector: string) =>
    selector
      .split(',')
      .map((part) => part.trim().replace(/\s+/g, ' '))
      .join(', ');
  const match = extractRuleBlocks(stripped).find(
    (block) => normalize(block.selector) === exactSelector,
  );
  expect(match, `could not locate the rule "${exactSelector}"`).toBeDefined();
  return match!.body;
}

/** Computes a selector's specificity as `[ids, classes, types]` for the syntax the cell-actions
 * pins use: type, class and id selectors, the descendant, child and sibling combinators, and
 * `:is()`, which counts as its most specific argument. Any other pseudo-class, a pseudo-element or
 * an attribute selector throws, so a selector outside that subset fails the test instead of being
 * miscounted. */
function specificity(selector: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  const rest = selector.replace(/:is\(([^()]*)\)/g, (_, args: string) => {
    const most = args
      .split(',')
      .map((arg) => specificity(arg.trim()))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
      .at(-1)!;
    most.forEach((count, i) => (total[i] += count));
    return '';
  });
  if (/[:[]/.test(rest)) throw new Error(`specificity() does not support "${selector}"`);
  total[0] += rest.match(/#[\w-]+/g)?.length ?? 0;
  total[1] += rest.match(/\.[\w-]+/g)?.length ?? 0;
  total[2] += rest.match(/(?:^|[\s>~+])[a-zA-Z][\w-]*/g)?.length ?? 0;
  return total;
}
