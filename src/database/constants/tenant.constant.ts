// Single tenant value until multi-tenancy ships. Every evidence-domain document below carries
// `tenantId` with this default so introducing real multi-tenancy later is an index-and-filter
// change, not a migration of every existing document.
export const DEFAULT_TENANT_ID = 'default';
