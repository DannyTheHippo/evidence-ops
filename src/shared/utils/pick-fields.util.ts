/*
 * Returns a sparse copy of a response object limited to `_id` plus the requested
 * fields that exist on it. Non-object input, and objects without an own `_id`
 * (e.g. health / info payloads), are returned untouched so the
 * global SelectInterceptor only ever prunes resource-shaped DTOs.
 */
export const pickFields = (obj: unknown, fields: string[]): unknown => {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  const source = obj as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(source, '_id')) {
    return obj;
  }

  const result: Record<string, unknown> = { _id: source._id };
  for (const field of fields) {
    if (field !== '_id' && Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = source[field];
    }
  }

  return result;
};
