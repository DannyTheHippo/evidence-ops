# React Patterns (SPA under `web/`)

Authoritative rules live in `rules/react.md`. This file is the shape reference. Stack: React 19.2,
react-router-dom 7.18, vite 8, vitest 4.

## Layout

```
web/src/
├── main.tsx              BrowserRouter mount
├── App.tsx               routes + RequireAuth/RequireAdmin + topbar (App.test.tsx alongside)
├── api/client.ts         the only place fetch is called
├── components/*.tsx      components lifted out of a page, colocated *.test.tsx
├── lib/auth.ts           session cache: ensureSession / setSession / clearSession
├── lib/use-session.ts    reactive hook over that cache
├── lib/document-index.ts, lib/locator.ts   pure helpers
├── pages/*.tsx           one file per route, colocated *.test.tsx
├── styles/               six fixed files, imported in this order from main.tsx:
│                         tokens.css, base.css, primitives.css, shell.css, rail.css, views.css
│                         (hex/rgba literals legal only in tokens.css)
└── test/setup.ts         vitest setup (jest-dom via /vitest, explicit afterEach(cleanup))
```

No `hooks/` directory exists — `use-session.ts` lives in `lib/`. Add a directory when a second real
consumer appears.

## Route guards — the client-side authorization story

```tsx
function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession();

  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

`RequireAdmin` nests on the same cache, additionally sending an authenticated non-admin to `/`.

The SPA holds no credential of its own — the session is an HttpOnly cookie — so `useSession()` asks
the server. `ensureSession()` (`lib/auth.ts`) probes `GET /auth/me` once, shares one in-flight probe
across concurrent callers, and caches the result module-scope; only login (`setSession`) and logout
(`clearSession`) invalidate it. Both fail **closed**: any non-200 resolves to `anon`. There is no
`AuthContext` and no auth state in a store. These guards decide only what renders — each server
route carries its own guard, which is the boundary. react-router-dom v7 declarative API only — no
`createBrowserRouter`, no loaders, no actions.

## Page component shape

`useState` for local state, a plain `async function` handler invoked as `onSubmit={(e) => void handleSubmit(e)}` (the `void` satisfies `no-floating-promises` under `recommendedTypeChecked`), `loading`/`error` tracked as local state, errors rendered with `role="alert"`.

## API access

Every call goes through an exported function in `web/src/api/client.ts`:

```ts
export function getMe(): Promise<Me> {
  return request<Me>('/auth/me');
}
```

`request()` owns `credentials: 'same-origin'` (what makes the browser attach the session cookie), the
`401 → window.location.assign('/login')` rule for everything outside `/auth/*`, the FormData
content-type exception, 204 handling, and `ApiError { status }`. `const API = '/api/v1'` is relative
— Vite proxies `/api` in dev, nginx in prod. Never hardcode an origin, never read `import.meta.env`.

Interfaces in `client.ts` (`Me`, `AuthToken`) mirror the API response DTOs by hand. Nothing type-checks across the two build roots: when a response DTO changes, change the interface in the same commit.

## Tests

```tsx
import { describe, expect, it } from 'vitest';

render(
  <MemoryRouter>
    <LoginPage />
  </MemoryRouter>,
);
expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
```

Explicit `vitest` imports (no globals), `MemoryRouter` for anything using router hooks, queries by
role/label/text. The `test` script runs under `NODE_OPTIONS=--no-experimental-webstorage` — Node 26's
own `localStorage` global otherwise shadows jsdom's and throws at import time.
