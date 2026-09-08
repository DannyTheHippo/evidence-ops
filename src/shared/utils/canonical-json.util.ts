/**
 * Serializes a value to canonical JSON: object keys sorted at every depth, no whitespace, so two
 * structurally equal values built in different key orders serialize identically. This is the
 * input to a sha256 a recipient uses to detect tampering, so that determinism is the whole point.
 *
 * Fails CLOSED: a value this function cannot represent deterministically — a non-finite number, a
 * bigint, or a top-level `undefined`/function/symbol — throws a `TypeError` rather than being
 * silently coerced or dropped.
 *
 * @param value The value to serialize. An object exposing a `toJSON` function (`Date`,
 *   `Types.ObjectId`) is replaced by its `toJSON()` result before recursion. Array holes and
 *   `undefined`/function/symbol array elements render as `null`; `undefined`/function/symbol
 *   object properties are omitted — both match `JSON.stringify`.
 * @returns The canonical JSON string.
 * @throws {TypeError} On a non-finite number, a bigint, or a top-level `undefined`/function/symbol.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: non-finite number');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not representable');
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: ${typeof value} is not representable`);
    default:
      break;
  }

  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === 'function') {
    return serialize((withToJson.toJSON as () => unknown).call(value));
  }

  if (Array.isArray(value)) {
    return serializeArray(value);
  }

  return serializeObject(value as Record<string, unknown>);
}

function serializeArray(value: readonly unknown[]): string {
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    /** A sparse-array hole has no own property at `index`; it renders like `undefined` does. */
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      items.push('null');
      continue;
    }

    const item = value[index];
    items.push(
      item === undefined || typeof item === 'function' || typeof item === 'symbol'
        ? 'null'
        : serialize(item),
    );
  }
  return `[${items.join(',')}]`;
}

function serializeObject(value: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const propertyValue = value[key];
    if (
      propertyValue === undefined ||
      typeof propertyValue === 'function' ||
      typeof propertyValue === 'symbol'
    ) {
      continue;
    }
    pairs.push(`${JSON.stringify(key)}:${serialize(propertyValue)}`);
  }
  return `{${pairs.join(',')}}`;
}
