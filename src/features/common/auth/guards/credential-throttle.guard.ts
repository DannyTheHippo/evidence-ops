import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import { TypedConfigService } from '../../../../config/environment/typed-config.service';
import { AuthenticatedRequest } from '../../../../shared/types/authenticated-request.type';

const UNRESOLVED_TRACKER = 'credential-unresolved';

/**
 * Bounds the two unauthenticated routes that run a bcrypt at cost 12 — `POST /auth/login` and
 * `POST /auth/register` — both far tighter than the general perimeter limit
 * `PreAuthThrottlerGuard` applies. Applied per handler with `@UseGuards()` rather than globally:
 * every other route costs a Mongo read, and none of them needs a ceiling this low.
 *
 * The caller address bounds the CPU: at the general limit these routes accept a burst that spends
 * more main-thread time hashing than there is wall-clock in the window, from one address, with no
 * credential at all.
 *
 * The submitted email refines that address bucket rather than standing beside it — the bucket is
 * the pair `(email, address)`. Within one address, attempts against a single account are held to a
 * ceiling below the address's own, so an address working one account is refused before the hash
 * while its budget against every other account stays untouched. A pool of K source addresses
 * therefore buys K times the per-pair ceiling against one account and no more.
 *
 * Keying the email alone is what this must not do. The bucket is spent before authentication runs,
 * so it cannot tell the account holder from an attacker; an email-only bucket is spendable against
 * a named account from anywhere, and spending it denies that account's owner their own correct
 * password for the rest of the window. The subject of a pre-authentication limit therefore has to
 * be something an attacker cannot aim at a stranger. A source address is that, an email is not.
 *
 * Both dimensions are consumed BEFORE the handler runs, and neither can become an
 * account-existence oracle: this guard reads no database and branches on nothing that depends on
 * an account existing, so the work it performs and the refusal it raises are identical for a
 * registered and an unregistered email. Consuming here rather than in `AuthService` is also what
 * keeps the ceiling meaningful — a refused request never reaches the hash it would otherwise pay
 * for.
 *
 * Failure directions:
 *
 * - The address dimension fails CLOSED: an unresolvable `request.ip` collapses onto one shared key,
 *   so those requests are bounded together rather than exempted by a unique or empty tracker.
 * - The email dimension fails OPEN when `request.ip` is unresolvable, leaving those requests to the
 *   shared address key alone. That key already holds every unresolvable-address caller to a single
 *   address's allowance, which is tighter than a per-email refinement of it; a per-email bucket
 *   hanging off a shared pseudo-address is spendable against a named account from anywhere, which
 *   is exactly the lockout the pair keying exists to prevent.
 * - The email dimension is SKIPPED when the body carries no string `email` — an invitation
 *   redemption legitimately carries only a token. Those requests remain bounded by the address
 *   dimension. Omitting `email` on a login skips the email bucket too, but buys nothing:
 *   `ValidationPipe` refuses that body before `AuthService.login` is reached, so no hash runs, and
 *   the address bucket has already counted the attempt.
 * - A spent email bucket denies only further attempts carrying that email from the address that
 *   spent it. The account holder is refused only when their own address is the one that spent the
 *   pair's allowance.
 * - The bound `ThrottlerStorage` itself is not defended against: a rejection propagates out of
 *   `canActivate` uncaught, so a broken store fails CLOSED, taking both credential routes down
 *   rather than exempting them from the limit it cannot currently enforce.
 */
@Injectable()
export class CredentialThrottleGuard implements CanActivate {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly config: TypedConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { credentialWindowMs, credentialIpLimit, credentialEmailLimit } = this.config.auth;
    const route = `${context.getClass().name}-${context.getHandler().name}`;

    const address = request.ip;
    await this.consume(
      `credential-ip:${route}:${address ?? UNRESOLVED_TRACKER}`,
      credentialIpLimit,
      credentialWindowMs,
    );

    const email = this.submittedEmail(request);
    if (email !== undefined && address !== undefined) {
      // The email segment is percent-encoded because it is caller-chosen text that has not reached
      // `ValidationPipe` yet, while an IPv6 address contains `:` — encoding leaves no separator in
      // the email segment, so no crafted email can compose a key that reads as another pair.
      await this.consume(
        `credential-email:${route}:${encodeURIComponent(email)}:${address}`,
        credentialEmailLimit,
        credentialWindowMs,
      );
    }

    return true;
  }

  private async consume(key: string, limit: number, windowMs: number): Promise<void> {
    // The throttler name is `key` itself, not a shared constant: `ThrottlerStorageService` indexes
    // its decay-timer bookkeeping by that name alone, across every key that shares it, and clears
    // all of a name's pending timers whenever any one key's block on that name resets. A name
    // shared by every credential key would let one caller's block-reset wipe every other caller's
    // pending decay, so their hit counts stop decaying and climb toward a block they never earned.
    const { isBlocked } = await this.storage.increment(key, windowMs, limit, windowMs, key);
    if (isBlocked) {
      throw new ThrottlerException();
    }
  }

  /**
   * Reads `email` off the raw body — guards run before `ValidationPipe`, so the value is whatever
   * was sent and only a string is usable. Lowercased to match `AuthService`'s own normalisation,
   * without which a case-varied address is a fresh bucket per variant.
   */
  private submittedEmail(request: AuthenticatedRequest): string | undefined {
    const body: unknown = request.body;
    if (typeof body !== 'object' || body === null) {
      return undefined;
    }

    const email = (body as Record<string, unknown>).email;
    return typeof email === 'string' ? email.toLowerCase() : undefined;
  }
}
