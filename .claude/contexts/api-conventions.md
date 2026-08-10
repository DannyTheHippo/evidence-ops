# API Conventions

Authoritative rules live in `rules/nestjs.md`. This file is the shape reference.

## Feature layout

```
src/features/{group}/{feature}/
├── {feature}.module.ts
├── {feature}.controller.ts
├── {feature}.service.ts
├── api-examples/{feature}.api-examples.ts
├── dtos/request/{name}.request.dto.ts
├── dtos/response/{name}.response.dto.ts
├── exceptions/{feature}.exception.ts
├── decorators/  guards/  types/   (as needed)
```

Tests mirror this under `test/`, never colocated. Existing groups: `common/` (auth, health, info).

## Controller handler — real shape

```ts
@Post('login')
@Version('1')
@PublicRoute()
@HttpCode(HttpStatus.OK)
@ApiResponse(loginApiExamples.success)
@ApiResponse(loginApiExamples.unauthorized)
async login(@Body() dto: LoginRequestDto): Promise<AuthTokenResponseDto> {
  return toResponseDto(AuthTokenResponseDto, await this.authService.login(dto));
}
```

Every handler: explicit `@Version('1')`, explicit `@HttpCode`, `@ApiResponse` per documented outcome, and a `toResponseDto(...)` wrapper on the return. Routes are authenticated unless `@PublicRoute()` says otherwise.

## Response DTO — every field needs `@Expose()`

```ts
export class MeResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Account identifier.' })
  id: string;
}
```

`toResponseDto` uses `excludeExtraneousValues: true`. A field without `@Expose()` vanishes from the payload with no error anywhere. Assert new response shapes in `test/e2e/serialization.e2e-spec.ts`.

## Request DTO

```ts
export class RegisterRequestDto {
  @ApiProperty({ example: 'user@example.com', description: 'Account email address.' })
  @IsEmail()
  email: string;
}
```

The global pipe runs `whitelist: true, forbidNonWhitelisted: true`: an undecorated field is stripped, an unknown field is a 400.

## Error response

`GlobalExceptionFilter` serializes the `HttpException` response. String messages become `{ status, message }`; object responses are spread as-is. Below production/staging it also attaches `stack` and, when present, `cause`.

Feature exceptions extend `BaseException(message, status, cause?)`. Throwing a bare `Error` collapses to a 500 with `Internal server error` and loses the detail.

## List and paging primitives

Reuse from `src/shared/dtos/`: `WithCountResponseDto<T>` (`{ docs, count }`), `PaginationRequestDto`, `SelectRequestDto`. Field selection is applied by the global `SelectInterceptor` — do not reimplement it per endpoint.
