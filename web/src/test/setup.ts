import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
