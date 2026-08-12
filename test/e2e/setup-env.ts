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
 * independently and leaves ample headroom for the other suites. The production default is asserted
 * separately by the environment config's own spec, which this override does not reach.
 */
process.env.THROTTLE_LIMIT = '30';
