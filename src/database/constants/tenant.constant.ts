// The tenant a document lands in when no authenticated tenant is in scope — the Temporal worker,
// the eval harness and migrations all run outside any request and pass their tenant explicitly, so
// this is a floor, not the single tenant value it once was. Isolation itself is enforced (ADR-0011):
// `tenantId` travels as a required JWT claim, every evidence service takes it as an explicit
// parameter, and `tenant-scope.plugin.ts` intersects it into Mongoose queries as a backstop. What
// remains deliberately unbuilt is tenant *provisioning* — email is still globally unique and nothing
// creates a second tenant outside the isolation suite.
export const DEFAULT_TENANT_ID = 'default';
