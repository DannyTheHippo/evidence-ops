/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import nginxConf from '../../nginx.conf?raw';
import { THEME_STORAGE_KEY } from '../components/shell/ThemeMenu';

/** `index.html` carries an inline theme bootstrap that has to run before first paint, so it cannot
 * import from the bundle and cannot be covered by a component test. That leaves two values in it
 * hand-mirrored from elsewhere in the tree, both of which fail silently when they drift — nothing
 * else in the suite loads this file. These assertions are the only thing holding either in place.
 *
 * Both files are read as `?raw` imports rather than through `node:fs`: `web/` has no
 * `@types/node`, and its Docker build stage copies only `web/`, so a `node:*` import type-checks
 * on a developer machine — where TypeScript walks up to the API root's `node_modules` — and fails
 * inside the container. */
/** The script element's text content, which is what CSP hashes — the newline immediately after the
 * open tag included. The HTML parser's "drop one leading newline" rule covers `pre`, `textarea` and
 * `listing` only, never `script`, so a capture that starts after that newline hashes to a value no
 * browser ever computes. */
function inlineThemeScript(): string {
  const match = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
  expect(match).not.toBeNull();
  return match![1];
}

describe('index.html ↔ nginx.conf', () => {
  /** Fails CLOSED. A stale hash blocks the bootstrap under CSP, and because the bootstrap exists
   * to set `data-theme` before first paint, every cold load then flashes the wrong theme. */
  it('hashes the script element text content, newline included', () => {
    // The property the hash depends on, asserted directly: a capture that trimmed this newline
    // would still agree with whatever value nginx.conf happened to hold, so comparing the two is
    // not on its own enough to catch it. Every browser hashes the text content as parsed.
    expect(inlineThemeScript().startsWith('\n')).toBe(true);
  });

  it('pins the current bytes of the inline theme script in the CSP script-src hash', async () => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(inlineThemeScript()),
    );
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));

    expect(nginxConf).toContain(`'sha256-${base64}'`);
  });

  /** Fails CLOSED. `default-src 'self'` gives `frame-src` no fallback of its own, so a CSP tidy-up
   * that drops this directive — or narrows it back to 'self' alone — blocks the document
   * workbench's `blob:` PDF pane in production only, the one environment Vite's no-CSP dev server
   * never exercises. */
  it('pins the widened frame-src the document workbench PDF pane needs', () => {
    expect(nginxConf).toContain("frame-src 'self' blob:");
  });
});

describe('index.html ↔ ThemeMenu', () => {
  /** Fails CLOSED. The bootstrap reads the key the menu writes; renaming `THEME_STORAGE_KEY`
   * alone leaves the bootstrap reading a key nothing sets, which is invisible to every other test
   * and shows up only as a flash of the wrong theme on a cold load. */
  it('reads the same storage key ThemeMenu writes', () => {
    expect(inlineThemeScript()).toContain(`'${THEME_STORAGE_KEY}'`);
  });
});
