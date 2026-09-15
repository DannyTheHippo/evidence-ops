---
paths:
  - "**/*.css"
  - "**/*.html"
---

# Styling Conventions

The SPA uses **plain CSS split across eight fixed files under `web/src/styles/`**: `tokens.css`,
`base.css`, `primitives.css`, `shell.css`, `rail.css`, `views.css`, `features.css`, `print.css`,
imported from `web/src/main.tsx` as eight explicit imports in that exact order — the order is the
cascade, so it stays visible where someone would look for it rather than hidden behind a barrel
file. `views.css` holds layout that every routed view sits in (`.container`, `.view`, `.page-head`
and their responsive rules); `features.css` holds the product feature blocks built on top of it, grouped under area banners
(`/* ── <Area>: <topic> ─…─ */`) in this order: Shared, Home, Sources, Data room, Ledger, measures &
entities, Answers, Runs, Admin & identity. `print.css` **MUST stay last** — its `@media print` block overrides an
unconditional rule from every earlier stylesheet and carries no specificity of its own, so it only
wins the cascade by sitting after all seven other imports; `web/src/test/styles-contract.test.ts`
pins this order and fails if `print.css` is not last. No Tailwind, no CSS Modules, no CSS-in-JS, no
preprocessor. Do not introduce a second styling mechanism for one component.

- **MUST** use the custom properties defined in `tokens.css` (surfaces, ink, signal colours, status
  tones, radii, spacing) rather than literal colour or size values. A hex or rgba literal is legal
  **only** in `tokens.css`; one anywhere else is a review finding.
- **MUST** add a new custom property to `tokens.css`'s `:root` block when a genuinely new token is
  needed, grouped under the existing commented sections, and mirrored into both dark selectors if it
  carries a literal value.
- Class naming is BEM-ish: block, then `block--modifier` (`btn btn--primary`, `card card--narrow`, `view view--flow`). Match it; no utility-class soup, no ad-hoc `id` styling.
- **MUST** check whether an existing class already covers the pattern before adding one — these files are a small, curated set, and near-duplicate blocks are the way it rots.
- Keep selectors flat. Descendant selectors are used sparingly and deliberately; deep nesting has no place here.
- Styling that expresses state belongs on a modifier class driven by React state, not on inline `style` props.
