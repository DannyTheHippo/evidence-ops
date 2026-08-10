---
paths:
  - "**/*.module.ts"
  - "**/*.controller.ts"
  - "**/*.service.ts"
  - "**/*.guard.ts"
  - "**/*.middleware.ts"
  - "**/*.interceptor.ts"
  - "**/*.pipe.ts"
  - "**/*.filter.ts"
  - "**/*.dto.ts"
  - "**/*.exception.ts"
  - "**/*.api-examples.ts"
---

Applies to the NestJS API under `src/`. The React SPA under `web/` follows `react.md`.

Before coding a controller/service pair, read 2-3 existing pairs under `src/features/common/` and match them exactly: logger init, DI shape, exception style, decorator order, DTO layout.

# NestJS API Patterns

## Two silent-failure traps — read these first

1. **Response DTO fields need `@Expose()`.** Every response goes through `toResponseDto(Dto, data)`, which calls `plainToInstance` with `excludeExtraneousValues: true`. A field without `@Expose()` is **silently dropped from the payload** — no error, no warning, no failing type-check. This is the most likely new-contributor bug. Add `@Expose()` to every field on every `*.response.dto.ts`, and cover the shape in an e2e assertion.
2. **Request DTO fields need a class-validator decorator.** The global `ValidationPipe` runs with `whitelist: true, forbidNonWhitelisted: true`. An undecorated property is stripped; an unexpected property makes the whole request a 400. A new request field is not "optional by default" — it does not arrive at all until it is decorated.

## Routing and versioning

- Global prefix `api`, URI versioning with `defaultVersion: '1'` (`src/config/app.config.ts`). Effective path: `/api/v1/{controller}/{route}`.
- **MUST** put `@Version('1')` and an explicit `@HttpCode(HttpStatus.X)` on every handler — the codebase is explicit about both even where the default matches.
- **MUST** add a feature-scoped `api-examples/{feature}.api-examples.ts` exporting an object of `ApiResponseOptions`, and reference each entry from `@ApiResponse()`. Swagger UI is served at `/docs`.
- Controller class carries `@Controller('{feature}')`, `@ApiTags('{feature}')`, and `@ApiBearerAuth()` when any handler is authenticated.

## Auth is deny-by-default

- `JwtAuthGuard` is registered as a global `APP_GUARD` in `AuthModule`. **Every new route is authenticated the moment it exists.**
- `@PublicRoute()` (`src/shared/decorators/public-route.decorator.ts`) is the only escape hatch. Applying it is a security decision — never add it to silence a 401 in a test.
- The guard sets `request.user` and stamps `store.user` into AsyncLocalStorage; the auditable Mongoose plugin reads that store. A route that bypasses the guard writes documents with no `createdBy`/`updatedBy`.

## Services

- Constructor injection, `private readonly` on every dependency, `@InjectModel(Entity.name)` for models.
- **MUST** call `this.logger.init(ServiceName.name)` in the constructor — `AppLogger` is transient and unnamed until it is.
- Business logic lives in the service. Controllers only validate, delegate, and serialize.

```ts
@Injectable()
export class FeatureService {
  constructor(
    @InjectModel(Feature.name)
    private readonly featureModel: Model<FeatureDocument>,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(FeatureService.name);
  }
}
```

## Errors

- **MUST** define feature-scoped exceptions in `exceptions/{feature}.exception.ts`, extending `BaseException` (`src/shared/exceptions/base.exception.ts`) with an explicit `HttpStatus` and an optional `cause`.
- **FORBIDDEN** to throw a bare `Error` from a service — `GlobalExceptionFilter` maps anything that is not an `HttpException` to a 500 with the message `Internal server error`, losing the detail.
- Pass the original error as `cause`: the filter attaches `stack` and `cause` to the body below prod-like environments only, so `cause` is how a real failure stays debuggable.

## DTOs

- Layout: `dtos/request/{name}.request.dto.ts` and `dtos/response/{name}.response.dto.ts`. Naming: `XxxRequestDto` / `XxxResponseDto`.
- Request DTOs: class-validator decorators + `@ApiProperty({ example, description })` on every field.
- Response DTOs: `@Expose()` + `@ApiProperty({ example, description })` on every field. See trap 1 above.
- Nested objects: `@Type(() => NestedDto)` + `@ValidateNested({ each: true })`.
- List responses: reuse `WithCountResponseDto<T>` (`{ docs, count }`) from `src/shared/dtos/response/`.
- Reuse `PaginationRequestDto` and `SelectRequestDto` from `src/shared/dtos/request/` rather than redefining paging or field-selection parameters.

## Configuration

- **FORBIDDEN** to read `process.env` outside `src/config/environment/environment.config.ts`. Inject `TypedConfigService` and read a namespace (`config.auth.jwtSecret`).
- Adding an environment variable touches six places — see `contexts/configuration.md` for the checklist. Miss one and the type-check fails project-wide or the value silently defaults.
- **FORBIDDEN** to read `.env`. `.env.example` is the safe reference; it holds no live values.

## Module wiring

- A feature module registers its own `MongooseModule.forFeature([...])`, its controller, and its providers, then is added to `AppModule.imports`.
- Global middleware (`CorrelationMiddleware`, `AsyncLocalStorageMiddleware`) is applied in `AppModule.configure()` with an explicit route-exclusion list. Extending that list is a request-context decision, not a formatting change.
