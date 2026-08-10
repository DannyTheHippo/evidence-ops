// Jest `setupFiles` run before the test framework is installed — i.e. before the spec
// file's own imports execute. That ordering matters here: `AppConfigModule`'s
// `ConfigModule.forRoot()` reads and validates `process.env` synchronously the moment it is
// first evaluated (at `AppModule`'s static import, decorator-time), so this must run first
// to override `.env`'s `MONGO_MEMORY_SERVER=false` for every e2e spec.
process.env.MONGO_MEMORY_SERVER = 'true';
