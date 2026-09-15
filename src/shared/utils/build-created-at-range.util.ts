/** Builds the `createdAt` clause for a list endpoint's optional `from`/`to` window: `from`
 *  inclusive, `to` exclusive. Returns an empty object when neither bound is given, so a caller
 *  spreads it unconditionally and gains no branch of its own. */
export function buildCreatedAtRange(
  from?: string,
  to?: string,
): { createdAt?: { $gte?: Date; $lt?: Date } } {
  if (from === undefined && to === undefined) {
    return {};
  }

  return {
    createdAt: {
      ...(from !== undefined ? { $gte: new Date(from) } : {}),
      ...(to !== undefined ? { $lt: new Date(to) } : {}),
    },
  };
}
