import { z } from 'zod';

// Same convention exception as `answer.contract.ts`'s header comment: `claimDecompositionContractSchema`
// is converted to a JSON Schema to constrain the model's structured output, so a runtime-validatable
// zod schema matters more here than parity with the HTTP DTO convention.

/** Upper bound on how many atoms one claim can decompose into. Keeps a decomposition call's output
 *  bounded regardless of how compound the source claim is. */
export const MAX_ATOMS_PER_CLAIM = 6;

/**
 * The model's entire output alphabet for one decomposition call: an ordered, non-empty list of
 * self-contained assertions, each restating exactly one thing the claim asserts. No confidence, no
 * reasoning, no verdict — the model only splits, it never grades what it split.
 */
export const claimDecompositionContractSchema = z
  .object({
    atoms: z.array(z.string().min(1).max(300)).min(1).max(MAX_ATOMS_PER_CLAIM),
  })
  .strict();

export type ClaimDecompositionContract = z.infer<typeof claimDecompositionContractSchema>;
