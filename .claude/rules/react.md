---
paths:
  - "**/*.tsx"
  - "web/src/**"
---

Applies to the SPA under `web/`. The NestJS API under `src/` follows `nestjs.md`.

Stack: React 19.2, react-router-dom 7.18, vite 8, vitest 4.

Before adding a component, read `web/src/pages/LoginPage.tsx` and `web/src/App.tsx` and match them exactly. `web/src/pages/` holds twenty pages, each carrying a colocated `*.test.tsx`, so "match the sibling" is always a short read; inventing structure ahead of need is the main failure mode here.

# React SPA Patterns

## What this SPA does not have

Stating these so they are not reintroduced by reflex:

- **No state library and no data-fetching library.** No Redux, Zustand, React Query, or SWR. Component state is `useState`; server calls go through the hand-written client in `web/src/api/client.ts`.
- **No `AuthContext` and no client-held credential.** The session is an HttpOnly cookie the browser sends on its own; the SPA stores no token. `ensureSession()` (`web/src/lib/auth.ts`) probes `GET /auth/me` once and caches the answer in a module-scope variable; `useSession()` (`web/src/lib/use-session.ts`) is the reactive shell over it. Both fail **closed** — a rejected probe resolves to `anon`, never to a stale "probably still logged in". `RequireAuth` and `RequireAdmin` in `App.tsx` read that cache and are the whole client-side authorization story; each server route carries its own guard, which is the actual boundary.
- **No `import.meta.env` and no `VITE_*` variables.** The API base is the relative constant `const API = '/api/v1'`. Vite proxies `/api` in dev (`web/vite.config.ts`); nginx proxies it in prod (`web/nginx.conf`). **FORBIDDEN** to hardcode `http://localhost:3000` in SPA code — it breaks the production build silently.
- **No component library, no CSS-in-JS, no Tailwind.** See `styles.md`.

Introducing any of the above is an architecture decision: raise it, do not slip it in with a feature.

## Components

- Components that need to expose a ref take it as a plain `ref` prop (React 19 passes `ref` like
  any other prop) — not `forwardRef`. Declare it explicitly in the props interface, since
  `ButtonHTMLAttributes` and friends don't type it; see `Button.tsx` and `IconButton.tsx`.
- Function components with hooks only. **FORBIDDEN** to introduce class components, with exactly one
  sanctioned exception: `web/src/components/ErrorBoundary.tsx`. React exposes error boundaries only
  through `getDerivedStateFromError`/`componentDidCatch`, which have no hook equivalent, so the
  alternatives are a class or a fourth runtime dependency. That file is the whole exception — a
  second class component anywhere is a review finding, and the boundary itself holds no logic beyond
  catching, resetting on route change, and rendering the fallback.
- Pages live in `web/src/pages/` as `PascalCase.tsx` with a default export and a colocated `PascalCase.test.tsx`. A page with genuinely separable responsibilities may split into a `pages/{name}/` directory instead: the route file re-exports the default, and each extracted piece carries its own colocated test.
- `web/src/components/` splits three ways: `components/ui/` holds the shared primitives (`Button`, `IconButton`, `Badge`, `Skeleton`, `EmptyState`, `Field`, `Select`, `Textarea`, `Table`, `Dialog`, `Menu`, `Pager`, `Toaster`, `toast.ts`) — `Select` and `Textarea` compose `Field` for the labelled-control shape rather than reimplementing it — reach for `Pager` before hand-rolling paging on a new list page, every existing paginated page already uses it; `components/shell/` holds the app shell composed by `App.tsx` (`Sidebar`, `Topbar`, `ConnectionStatus`, `ThemeToggle`); the `components/` root holds components lifted out of one specific page (`AnswerView.tsx` and `ProvenanceRail.tsx`, rendered by both `AskPage` and `AnswerDetailPage`, plus `VerificationLedger.tsx`, rendered inside `AnswerView.tsx`) plus `ErrorBoundary.tsx` (the one sanctioned class component, wrapping the routed area from `App.tsx` **outside** its `Suspense` boundary so a failed dynamic chunk import renders the fallback rather than an empty `#root`) and the shared `icons.tsx` set. Every one carries its own colocated test. `web/src/lib/` holds the non-component helpers: `auth.ts`, `use-session.ts`, `use-event-stream.ts`, `use-answer-enrichment.ts` (the document-title and conflict-chunk enrichment `AskPage` and `AnswerDetailPage` both need for a completed answer), `document-index.ts`, `locator.ts`, `identifiers.ts` (the shared shortening/labelling of digests, uuids and workflow types — a raw identifier rendered in full anywhere in the SPA should be reaching for this instead), `format-interval.ts` (names a sync cadence in its coarsest clearing unit), `workflow-runs.ts` (the shared `isTerminalRun` check), `answer-status.ts` (`RUN_STATUS_TONE` plus `answerBadge`, which resolves an answer to its `{ tone, label }` pair — it returns the mapping rather than a rendered `Badge`, which is what lets a status vocabulary live in `lib/` at all, and why the labels are lowercase in exactly one place instead of three). There is no `hooks/` directory — `use-session.ts` lives in `lib/`. Lift a page-local component only when a real second consumer exists, not preemptively.
- Colocate state with the component that owns it; lift only as far as a real common consumer requires.

## Data access

- All API calls go through `web/src/api/client.ts`. **MUST** add a typed exported function there rather than calling `fetch` from a component.
- The client already centralizes: `credentials: 'same-origin'` so the browser attaches the session cookie, the 401-redirect-to-login rule (`window.location.assign('/login')`, skipped for `/auth/*` so a failed login renders its own error), the FormData content-type exception, 204 handling, and `ApiError` with a `status`. Do not duplicate that logic per call site.
- Response interfaces in `client.ts` mirror the API's response DTOs. When an API DTO changes, update the interface in the same change — nothing type-checks across the two roots.

## Router

- `react-router-dom` v7, declarative `<BrowserRouter>` / `<Routes>` / `<Route>`. **Not** the data-router API — `createBrowserRouter`, loaders, and actions are not in use. One consequence worth knowing before promising a feature: there is no navigation-blocking API, so an unsaved-changes guard covers tab close and reload via `beforeunload` but cannot stop an in-app `<Link>` or the back gesture.
- **The route table is split across two files, and the split is load-bearing.** `App.tsx` statically imports only what an anonymous visitor can reach (`LoginPage`, `InvitePage`) and pulls everything else through a single `lazy(() => import('./AuthenticatedRoutes'))`. `AuthenticatedRoutes.tsx` statically imports all eighteen guarded pages plus `RequireAuth`/`RequireAdmin`/`NotFoundView`, so Rollup emits **one** chunk for the whole authenticated app rather than one per page. Adding a guarded route means editing `AuthenticatedRoutes.tsx`; adding a dynamic `import()` per page would fragment that chunk across a `listen 80` origin capped at six connections.
- New authenticated routes wrap their element in `<RequireAuth>`; admin-only routes wrap in `<RequireAdmin>`, which redirects a non-admin to `/`.

## Hooks

- **MUST** call hooks unconditionally at the top level.
- **MUST** keep `useEffect`/`useCallback`/`useMemo` dependency arrays exhaustive. Do not suppress `react-hooks/exhaustive-deps` without an inline justification naming the rule.
- `eslint` runs `typescript-eslint` `recommendedTypeChecked` here: floating promises are errors. Event handlers that call an async function use `onSubmit={(e) => void handleSubmit(e)}`, matching `LoginPage.tsx`.

# SPA Testing (vitest + Testing Library)

- Runner: **vitest 4**, configured inline in `web/vite.config.ts` (`test` key) — there is no `vitest.config.ts`. `environment: 'jsdom'`, setup at `web/src/test/setup.ts`.
- Test files are `*.test.tsx`, colocated with the component. Run with `npm --prefix web run test`.
- The `test` script runs vitest under `NODE_OPTIONS=--no-experimental-webstorage`. Node 26 exposes its own `localStorage` global, which shadows jsdom's inside the test environment and throws unless Node was given a backing store. `web/src/lib/auth.ts` touches `localStorage` at module scope, so without the flag every test that imports the API client throws on import, before any assertion runs. Any new SPA test lane needs the same flag.
- A test exercising `useEventStream` or an `EventSource`-backed page **MUST** install `web/src/test/fake-event-source.ts`'s `FakeEventSource` via `vi.stubGlobal('EventSource', FakeEventSource)` — jsdom has no native `EventSource`, so an unstubbed test only exercises the hook's undefined-`EventSource` fallback path.
- **MUST** import `describe`/`it`/`expect` explicitly from `vitest` — globals are not enabled.
- `@testing-library/jest-dom` is registered via its `/vitest` entrypoint in the setup file; `toBeInTheDocument()` and friends are available without a per-file import. That same file registers an explicit `afterEach(cleanup)`, because Testing Library's auto-cleanup only installs itself when vitest globals are on.
- **MUST** query by role, label, or text — never by class name or test id when an accessible query exists.
- A component using router hooks **MUST** be rendered inside `<MemoryRouter>`.
- There is no coverage threshold on the SPA. Absence of a gate is not permission to skip the test — a new page ships with a rendering test at minimum.
