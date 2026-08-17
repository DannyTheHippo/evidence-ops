import { UserRole } from '../../../shared/enums/user-role.enum';

/**
 * `TOKEN_VERIFIER` binds to `ApiKeysService`, which verifies personal access tokens. A second
 * implementation (OAuth 2.1) can bind to the same token later without any consumer rewrite — the
 * seam is `verify()`, not the PAT format underneath it.
 */
export interface VerifiedIdentity {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: UserRole;
  /** The verified user's own email, when the verifying implementation resolves one from a live
   *  identity row (`ApiKeysService.verify` does, from the `User` it already loads). Optional so a
   *  future `TokenVerifier` binding with no email to give — one backed by a service principal, for
   *  instance — still satisfies this interface. */
  readonly email?: string;
}

export interface TokenVerifier {
  /** Returns the caller's identity for a valid, live token, or `null` for anything else — an
   *  unrecognized, malformed, revoked, or expired token never throws, it simply fails to
   *  identify anyone. */
  verify(token: string): Promise<VerifiedIdentity | null>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
