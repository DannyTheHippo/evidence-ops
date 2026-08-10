---
paths:
  - "**/*.css"
  - "**/*.html"
---

# Styling Conventions

The SPA uses **plain CSS in a single stylesheet**: `web/src/styles.css`. No Tailwind, no CSS Modules, no CSS-in-JS, no preprocessor. Do not introduce a second styling mechanism for one component.

- **MUST** use the custom properties defined in `:root` (surfaces, ink, accent, signal colours, radii, spacing) rather than literal colour or size values. A new literal hex in a rule body is a review finding.
- **MUST** add a new custom property to the `:root` block when a genuinely new token is needed, grouped under the existing commented sections.
- Class naming is BEM-ish: block, then `block--modifier` (`btn btn--primary`, `card card--narrow`, `view view--flow`). Match it; no utility-class soup, no ad-hoc `id` styling.
- **MUST** check whether an existing class already covers the pattern before adding one — the stylesheet is a small, curated set, and near-duplicate blocks are the way it rots.
- Keep selectors flat. Descendant selectors are used sparingly and deliberately; deep nesting has no place in a flat stylesheet.
- Styling that expresses state belongs on a modifier class driven by React state, not on inline `style` props.
