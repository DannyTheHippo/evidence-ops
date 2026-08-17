/**
 * The seeded demo tenant, and a floor for contexts that run outside any request — migrations, the
 * eval harness, and any process without an authenticated caller to derive a tenant from. Every
 * evidence service takes `tenantId` as a required, explicit parameter; this constant is never a
 * silent fallback for a missing one. Registration provisions a real per-user tenant, so most users
 * never touch this value at all. Isolation itself is enforced by `tenantId` traveling as a required
 * JWT claim plus `tenant-scope.plugin.ts` intersecting it into Mongoose queries as a backstop;
 * `email` stays globally unique rather than tenant-scoped.
 */
export const DEFAULT_TENANT_ID = 'default';
