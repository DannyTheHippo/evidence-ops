/** The self-contained assertions `ClaimDecompositionService` split one claim's `statement` into —
 * `claimIndex` positions it against the claim's index in the model's `claims` array. */
export interface ClaimAtoms {
  readonly claimIndex: number;
  readonly statement: string;
  readonly atoms: readonly string[];
}

/** Counts summarizing how atomization and its downstream checks behaved across one answer's
 * claims. Every count is over claims, not atoms. */
export interface AtomizationSummary {
  readonly decomposedClaimCount: number;
  readonly coverageFallbackCount: number;
  readonly atomDroppedClaimCount: number;
  readonly contradictionDroppedClaimCount: number;
}
