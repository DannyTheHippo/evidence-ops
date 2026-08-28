// Jest `setupFiles` run before the test framework is installed — i.e. before the spec
// file's own imports execute. That ordering matters here: `AppConfigModule`'s
// `ConfigModule.forRoot()` reads and validates `process.env` synchronously the moment it is
// first evaluated (at `AppModule`'s static import, decorator-time), so this must run first
// to override `.env`'s `MONGO_MEMORY_SERVER=false` for every e2e spec.
process.env.MONGO_MEMORY_SERVER = 'true';

/**
 * Lowers the throttle limit for e2e only, from the production default of 100.
 *
 * Proving the throttler guard rejects a burst costs `limit + 1` requests, so a limit of 100 forced
 * a 120-request loop. Each of those requests hits `/health`, which pings Mongo, and the e2e suites
 * run in parallel with a separate in-memory mongod per worker — the loop took 8s alone but over 60s
 * under that contention, which is what made the burst case time out intermittently and drag
 * neighbouring suites down with it. A smaller limit proves exactly the same property (the guard is
 * wired and enforces whatever it is configured with) for a fraction of the work.
 *
 * Buckets are keyed per handler, not globally, so this ceiling applies to each route
 * independently. 40 rather than 30: `api-keys.e2e-spec.ts` alone drives close to 30 requests
 * through the `mint` handler's own bucket across its fixtures, leaving no real room for another
 * suite sharing that bucket to add coverage without tripping the burst test's own assertions. The
 * production default is asserted separately by the environment config's own spec, which this
 * override does not reach.
 */
process.env.THROTTLE_LIMIT = '40';

/**
 * Raises only the per-address half of `CredentialThrottleGuard` for e2e, from the production
 * default of 10.
 *
 * Supertest reaches the app from a single loopback address, so every registration and login in a
 * suite — dozens across the fixtures a file sets up — shares one bucket that a real deployment
 * would spread across as many addresses as there are users. The production default is asserted by
 * the environment config's own spec, which this override does not reach.
 *
 * `AUTH_CREDENTIAL_EMAIL_LIMIT` is deliberately NOT raised: fixtures use a distinct address per
 * user, so the shipped value holds throughout, and the burst case in `auth.e2e-spec.ts` proves the
 * guard against the number production runs.
 */
process.env.AUTH_CREDENTIAL_IP_LIMIT = '150';

/**
 * Pins CORS origin for e2e so a developer `.env` (`CORS_ORIGIN` in `.env.example` is the Vite
 * preview port) cannot change what `CsrfOriginMiddleware` accepts. The auth e2e asserts against
 * this value.
 */
process.env.CORS_ORIGIN = 'http://localhost:5173';
