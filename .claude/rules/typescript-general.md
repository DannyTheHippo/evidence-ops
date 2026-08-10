---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript Conventions

- TypeScript strict mode. **FORBIDDEN** to use `any` — use `unknown` or generics with documented justification.
- **FORBIDDEN** to use `// eslint-disable` without a specific rule name and inline justification.
- Conventional Commits convention: `feat(scope):`, `fix(scope):`, `docs:`, `refactor:`, `chore:`.
- Never commit secrets. Use environment variables + `.env`.
- **MUST** read tsconfig.json to understand strictness settings before coding.
- **MUST** match the project's quote style, semicolons, and trailing commas — check .prettierrc or .editorconfig.
- **MUST** follow existing import ordering patterns (framework imports, third-party, local).
- **MUST** use existing utility types and functions before creating new ones.
- **MUST** check for path aliases in tsconfig before using deep relative imports.
- **MUST** respect the project's enum style (string enums, const enums, or union types).

## This project

- Two tsconfigs, two strictness profiles. `tsconfig.json` (API) is `NodeNext` + decorators + `emitDecoratorMetadata`, with `strictPropertyInitialization: false` (DTO and schema classes are hydrated by class-transformer/Mongoose, never a constructor). `web/tsconfig.json` is bundler resolution + `react-jsx`.
- **No path aliases in either root.** Relative imports are the convention — do not introduce `@app/*`-style aliases without changing both tsconfig and the jest/vite resolvers.
- `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, and `noImplicitOverride` are on: an unused import or a missing `return` fails `tsc`, not just the linter.
- Enums are string enums in `src/shared/enums/` with a `.enum.ts` suffix (`NodeEnv`); inline union types are used for narrow local shapes (`type Mode = 'login' | 'signup'`).
