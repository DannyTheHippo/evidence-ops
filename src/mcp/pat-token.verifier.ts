import { Inject, Injectable } from '@nestjs/common';
import {
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '../features/platform/api-keys/token-verifier.interface';
import type { ToolExecutionContext } from '../features/platform/authz/types/tool-definition.type';

/** `Authorization: Bearer <token>` only — no cookie fallback (unlike `JwtAuthGuard`, this surface
 *  has no browser session to read a cookie from). Returns `undefined` for a missing header, a
 *  header with the wrong scheme, or a scheme with no token after it. */
function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return undefined;
  }

  return authorizationHeader.slice('Bearer '.length).trim() || undefined;
}

/**
 * The only place this process turns a raw `Authorization` header into a `ToolExecutionContext` —
 * every field of that context comes from `TOKEN_VERIFIER`'s resolution of the presented token,
 * never from anything else in the request. Delegates verification to the injected `TokenVerifier`
 * seam (`ApiKeysService` today) rather than re-implementing it; this class only extracts the
 * header and reshapes a live `VerifiedIdentity` into the context shape `ToolExecutorService`
 * expects.
 *
 * Fails CLOSED: a missing header, a malformed Bearer value, or a token `TOKEN_VERIFIER` itself
 * refuses (unknown, revoked, expired, malformed) all resolve to `null` — never throws, never a
 * partial context.
 */
@Injectable()
export class PatTokenVerifier {
  constructor(
    @Inject(TOKEN_VERIFIER)
    private readonly tokenVerifier: TokenVerifier,
  ) {}

  async verify(authorizationHeader: string | undefined): Promise<ToolExecutionContext | null> {
    const token = extractBearerToken(authorizationHeader);
    if (!token) {
      return null;
    }

    const identity = await this.tokenVerifier.verify(token);
    if (!identity) {
      return null;
    }

    return {
      tenantId: identity.tenantId,
      actorId: identity.userId,
      role: identity.role,
      email: identity.email,
    };
  }
}
