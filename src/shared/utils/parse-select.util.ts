/*
 * Normalizes the `select` query value into a clean list of field names.
 * Accepts a comma-separated string (`name,status`) and Express' repeated-param
 * array (`?select=name&select=status`); trims and drops empty entries.
 */
export const parseSelect = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : [raw])
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
