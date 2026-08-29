/*
 * Escapes every regex metacharacter in `value` so it can be interpolated into a `RegExp`/Mongo
 * `$regex` literally. Fails CLOSED toward literal matching: a caller-supplied string never gains
 * regex meaning it did not ask for, which rules out both a wrong-result match on an unintended
 * pattern and a catastrophic-backtracking pattern built from hostile input.
 */
export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
