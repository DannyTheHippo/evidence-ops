# React Patterns (SPA under `web/`)

Authoritative rules live in `rules/react.md`. This file is the shape reference.

## Layout

```
web/src/
├── main.tsx          BrowserRouter mount
├── App.tsx           routes + RequireAuth + topbar
├── api/client.ts     the only place fetch is called
├── lib/auth.ts       localStorage token get/set/clear
├── pages/*.tsx       one file per route, colocated *.test.tsx
├── styles.css        single stylesheet, custom properties
└── test/setup.ts     vitest setup (jest-dom via /vitest)
```

No `components/` or `hooks/` directory exists yet. Add one when a second real consumer appears.

## Route guard — the whole authorization story

```tsx
function RequireAuth({ children }: { children: ReactNode }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
```

`getToken()` reads `localStorage` on every render. There is no `AuthContext` and no auth state in a store. react-router-dom v6 declarative API only — no `createBrowserRouter`, no loaders, no actions.

## Page component shape

`useState` for local state, a plain `async function` handler invoked as `onSubmit={(e) => void handleSubmit(e)}` (the `void` satisfies `no-floating-promises` under `recommendedTypeChecked`), `loading`/`error` tracked as local state, errors rendered with `role="alert"`.

## API access

Every call goes through an exported function in `web/src/api/client.ts`:

```ts
export function getMe(): Promise<Me> {
  return request<Me>('/auth/me');
}
```

`request()` owns the bearer header, the `401 → clearToken + redirect to /login` rule, 204 handling, and `ApiError { status }`. `const API = '/api/v1'` is relative — Vite proxies `/api` in dev, nginx in prod. Never hardcode an origin, never read `import.meta.env`.

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

Explicit `vitest` imports (no globals), `MemoryRouter` for anything using router hooks, queries by role/label/text.
