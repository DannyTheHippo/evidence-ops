import { z } from 'zod';

/**
 * Locators point at a place in a source document, not at a chunk id. Chunking strategy will
 * change repeatedly as retrieval is tuned; a dataset keyed to chunk ids would silently rot
 * every time chunk boundaries move, whereas a locator (file + page / paragraph index /
 * sheet+cell) stays meaningful and can be resolved against whatever chunks exist at run time
 * by span overlap. See eval/dataset/README.md.
 */
export const PdfPageLocatorSchema = z.object({
  kind: z.literal('pdf-page'),
  file: z.string().min(1),
  page: z.number().int().positive(),
});

export const XlsxCellLocatorSchema = z.object({
  kind: z.literal('xlsx-cell'),
  file: z.string().min(1),
  sheet: z.string().min(1),
  // Single cell ("F2") or a range ("A2:H11").
  cell: z.string().regex(/^[A-Z]+\d+(:[A-Z]+\d+)?$/, 'expected an A1-style cell or range'),
});

export const DocxParagraphLocatorSchema = z.object({
  kind: z.literal('docx-paragraph'),
  file: z.string().min(1),
  paragraphIndex: z.number().int().nonnegative(),
  headingPath: z.array(z.string().min(1)),
});

export const LocatorSchema = z.discriminatedUnion('kind', [
  PdfPageLocatorSchema,
  XlsxCellLocatorSchema,
  DocxParagraphLocatorSchema,
]);

export const EvalCategorySchema = z.enum([
  'answerable',
  'unanswerable',
  'conflicting',
  'adversarial',
]);

export const EvalOutcomeSchema = z.enum([
  'answer',
  'abstain',
  'surface_conflict',
  'refuse_injection',
]);

export const EvalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z]+-\d{3}$/, 'expected "<category-prefix>-NNN", e.g. "ans-001"'),
    category: EvalCategorySchema,
    question: z.string().min(1),
    expectedLocators: z.array(LocatorSchema),
    /**
     * Substrings that must appear in the text at `expectedLocators`, written exactly as the
     * document renders them ("5.25%", not "5.25 percent") because the check is string containment
     * against parsed text.
     *
     * Two jobs. It lets `dataset.spec.ts` prove a locator points at the *right* text rather than
     * merely existing — the weaker check is what allowed a fixture bug to shift every PDF page by
     * one while every test stayed green. And it gives the eval harness something to score answer
     * correctness against; locators and an outcome alone can only score retrieval and abstention.
     */
    expectedAnswerContains: z.array(z.string().min(1)).optional(),
    expectedOutcome: EvalOutcomeSchema,
    notes: z.string().min(1),
  })
  .superRefine((evalCase, ctx) => {
    // unanswerable/adversarial cases have no ground-truth answer location by construction;
    // answerable/conflicting cases must point somewhere or the case is untestable.
    const requiresLocators =
      evalCase.category === 'answerable' || evalCase.category === 'conflicting';
    if (requiresLocators && evalCase.expectedLocators.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `category "${evalCase.category}" requires at least one expected locator`,
        path: ['expectedLocators'],
      });
    }
    if (requiresLocators && (evalCase.expectedAnswerContains ?? []).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `category "${evalCase.category}" requires expectedAnswerContains — without it the case can assert that a locator exists but not that it holds the answer`,
        path: ['expectedAnswerContains'],
      });
    }
    if (evalCase.category === 'conflicting' && evalCase.expectedOutcome !== 'surface_conflict') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'category "conflicting" must have expectedOutcome "surface_conflict"',
        path: ['expectedOutcome'],
      });
    }
    if (evalCase.category === 'unanswerable' && evalCase.expectedOutcome !== 'abstain') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'category "unanswerable" must have expectedOutcome "abstain"',
        path: ['expectedOutcome'],
      });
    }
    if (evalCase.category === 'adversarial' && evalCase.expectedOutcome !== 'refuse_injection') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'category "adversarial" must have expectedOutcome "refuse_injection"',
        path: ['expectedOutcome'],
      });
    }
    if (evalCase.category === 'answerable' && evalCase.expectedOutcome !== 'answer') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'category "answerable" must have expectedOutcome "answer"',
        path: ['expectedOutcome'],
      });
    }
  });

export const EvalDatasetSchema = z.array(EvalCaseSchema);

export type Locator = z.infer<typeof LocatorSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalCategory = z.infer<typeof EvalCategorySchema>;
export type EvalOutcome = z.infer<typeof EvalOutcomeSchema>;
