---
name: nest-feature
description: Scaffold a NestJS feature module in this project's layout, with tests, DTOs, and Swagger examples
user-invocable: true
argument-hint: <feature-name> [group]
context: fork
---

# NestJS Feature Scaffolding

Scaffold the feature described by "$ARGUMENTS". Default group is `common` unless a second argument names another.

## 1. Read before writing

- `.claude/CLAUDE.md` and `.claude/project-discovery.json`.
- `.claude/rules/nestjs.md` — in particular the two silent-failure traps.
- One existing feature end to end (`src/features/common/auth/` is the richest; `info/` is the smallest). Match its decorator order, DI shape, logger init, and exception style exactly.

## 2. Generate

```
src/features/{group}/{feature}/
├── {feature}.module.ts
├── {feature}.controller.ts
├── {feature}.service.ts
├── api-examples/{feature}.api-examples.ts
├── dtos/request/{name}.request.dto.ts      (only if the feature takes input)
├── dtos/response/{name}.response.dto.ts
└── exceptions/{feature}.exception.ts       (only if it can fail in a feature-specific way)
```

Tests go under `test/`, mirroring the source path — **not** colocated:

```
test/features/{group}/{feature}/{feature}.service.spec.ts
```

Create `decorators/`, `guards/`, `types/` only when the feature actually needs them. Do not scaffold empty directories.

## 3. Non-negotiables for the generated code

- Controller class: `@Controller('{feature}')`, `@ApiTags('{feature}')`, plus `@ApiBearerAuth()` if any handler is authenticated.
- Every handler: `@Version('1')`, explicit `@HttpCode(HttpStatus.X)`, one `@ApiResponse(...)` per documented outcome sourced from `api-examples/`, and a `toResponseDto(Dto, ...)` wrapper on the return value.
- Routes are authenticated by default (global `JwtAuthGuard`). Add `@PublicRoute()` only when the route is genuinely public, and say so in the summary — it is a security decision.
- Service: constructor injection, `private readonly` dependencies, `@InjectModel(Entity.name)`, and `this.logger.init(FeatureService.name)` in the constructor.
- Response DTO: `@Expose()` **and** `@ApiProperty({ example, description })` on every field. A missing `@Expose()` drops the field silently.
- Request DTO: a class-validator decorator **and** `@ApiProperty` on every field. Undecorated fields are stripped by the global `ValidationPipe`.
- Exceptions extend `BaseException(message, status, cause?)`. Never throw a bare `Error`.
- Reuse `WithCountResponseDto<T>`, `PaginationRequestDto`, `SelectRequestDto` from `src/shared/dtos/` for list, paging, and field selection.

## 4. Wire and verify

- Register the schema in the feature module's `MongooseModule.forFeature([...])` if it owns one, then add the module to `AppModule.imports`.
- The service spec **must** reach 100% branch coverage — `collectCoverageFrom` is scoped to `src/**/*.service.ts` and every global threshold is 100. Reuse `test/utils/get-mock-model.ts`, `get-mock-logger.ts`, `get-mock-config.ts`.
- Add or extend an e2e in `test/e2e/` if the feature introduces a new response shape or error contract.
- Run `<scripts.checks>` and report the result. Do not claim done on red.
