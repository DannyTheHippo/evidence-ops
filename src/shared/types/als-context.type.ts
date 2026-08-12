export interface AlsContext {
  'correlation-id': string;
  user?: string;
  // Optional because the worker, the eval harness, and migrations all run outside any request
  // and legitimately have no tenant in scope — that absence must stay a no-op, not a failure.
  tenant?: string;
}
