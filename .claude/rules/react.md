---
paths:
  - "**/*.tsx"
  - "web/src/**"
---

Applies to the SPA under `web/`. The NestJS API under `src/` follows `nestjs.md`.

Before adding a component, read `web/src/pages/LoginPage.tsx` and `web/src/App.tsx` and match them exactly. The SPA is deliberately small — five source files — so "match the sibling" is a short read, and inventing structure ahead of need is the main failure mode here.

# React SPA Patterns

## What this SPA does not have

Stating these so they are not reintroduced by reflex:

- **No state library and no data-fetching library.** No Redux, Zustand, React Query, or SWR. Component state is `useState`; server calls go through the hand-written client in `web/src/api/client.ts`.
- **No `AuthContext`.** Auth state is read from `localStorage` on every render via `getToken()` (`web/src/lib/auth.ts`). `RequireAuth` in `App.tsx` is the whole authorization story.
- **No `import.meta.env` and no `VITE_*` variables.** The API base is the relative constant `const API = '/api/v1'`. Vite proxies `/api` in dev (`web/vite.config.ts`); nginx proxies it in prod (`web/nginx.conf`). **FORBIDDEN** to hardcode `http://localhost:3000` in SPA code — it breaks the production build silently.
- **No component library, no CSS-in-JS, no Tailwind.** See `styles.md`.

Introducing any of the above is an architecture decision: raise it, do not slip it in with a feature.

## Components

- Function components with hooks only. **FORBIDDEN** to introduce class components.
- Pages live in `web/src/pages/` as `PascalCase.tsx` with a default export and a colocated `PascalCase.test.tsx`.
- There is no `components/` or `hooks/` directory yet. Create one when a second consumer actually exists — not preemptively.
- Colocate state with the component that owns it; lift only as far as a real common consumer requires.

## Data access

- All API calls go through `web/src/api/client.ts`. **MUST** add a typed exported function there rather than calling `fetch` from a component.
- The client already centralizes: bearer-token injection, the 401-redirect-to-login rule, 204 handling, and `ApiError` with a `status`. Do not duplicate that logic per call site.
- Response interfaces in `client.ts` mirror the API's response DTOs. When an API DTO changes, update the interface in the same change — nothing type-checks across the two roots.

## Router

- `react-router-dom` v6, declarative `<BrowserRouter>` / `<Routes>` / `<Route>`. **Not** the v7 data-router API — `createBrowserRouter`, loaders, and actions are not in use.
- New authenticated routes wrap their element in `<RequireAuth>`.

## Hooks

- **MUST** call hooks unconditionally at the top level.
- **MUST** keep `useEffect`/`useCallback`/`useMemo` dependency arrays exhaustive. Do not suppress `react-hooks/exhaustive-deps` without an inline justification naming the rule.
- `eslint` runs `typescript-eslint` `recommendedTypeChecked` here: floating promises are errors. Event handlers that call an async function use `onSubmit={(e) => void handleSubmit(e)}`, matching `LoginPage.tsx`.

# SPA Testing (vitest + Testing Library)

- Runner: **vitest**, configured inline in `web/vite.config.ts` (`test` key) — there is no `vitest.config.ts`. `environment: 'jsdom'`, setup at `web/src/test/setup.ts`.
- Test files are `*.test.tsx`, colocated with the component. Run with `npm --prefix web run test`.
- **MUST** import `describe`/`it`/`expect` explicitly from `vitest` — globals are not enabled.
- `@testing-library/jest-dom` is registered via its `/vitest` entrypoint in the setup file; `toBeInTheDocument()` and friends are available without a per-file import.
- **MUST** query by role, label, or text — never by class name or test id when an accessible query exists.
- A component using router hooks **MUST** be rendered inside `<MemoryRouter>`.
- There is no coverage threshold on the SPA. Absence of a gate is not permission to skip the test — a new page ships with a rendering test at minimum.
