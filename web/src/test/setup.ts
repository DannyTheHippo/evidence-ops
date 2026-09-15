import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The default 1000ms `findBy*`/`waitFor` timeout is tuned for a single-threaded run; this suite
// runs every file in its own worker thread, and a mocked async resolution can cross that window
// under the CPU contention many parallel threads create, without anything having actually gone
// wrong. Matches the timeout InvitePage.test.tsx already reaches for per-call.
configure({ asyncUtilTimeout: 3000 });

// `globals: true` is deliberately off (react.md — explicit vitest imports, no globals), so
// Testing Library's own auto-cleanup (which only registers when it finds a global `afterEach`)
// never fires. Multi-test files that call `render` more than once need this, or DOM from an
// earlier test leaks into later assertions.
afterEach(() => {
  cleanup();
});

// jsdom implements no layout engine, so `Element.prototype.scrollIntoView` is absent entirely —
// any component that scrolls a deep-linked target into view throws without this stand-in.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
