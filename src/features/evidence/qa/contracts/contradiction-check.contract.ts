import { z } from 'zod';

// Same convention exception as `answer.contract.ts`'s header comment: converted to a JSON Schema
// to constrain the model's structured output.

/**
 * The model's entire output alphabet for one contradiction check, deliberately this small: one
 * boolean. `contradicted: true` can only lower a verdict this codebase already computed, via
 * `reasonCode: 'claim-contradicted'` — it can never author a verdict of its own. This is the same
 * shape ADR-0020 rejected adding to `ClaimVerdict`: a model opinion about disagreement must never
 * become a truth claim in the record.
 */
export const contradictionCheckContractSchema = z.object({ contradicted: z.boolean() }).strict();
