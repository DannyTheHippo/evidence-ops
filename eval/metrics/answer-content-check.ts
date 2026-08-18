/**
 * Whether every dataset-declared substring in `expectedAnswerContains` appears in the answer text
 * an `answerable` case actually produced. Comparison is case-insensitive on whitespace-normalized
 * text: `expectedAnswerContains` is written exactly as the source document renders a figure
 * ("5.25%"), but the model's own prose is free to differ in case or surrounding whitespace without
 * that being a real answer-correctness failure.
 */
export function answerContainsExpectedStrings(
  answerText: string,
  expectedAnswerContains: readonly string[],
): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedAnswer = normalize(answerText);
  return expectedAnswerContains.every((expected) => normalizedAnswer.includes(normalize(expected)));
}
