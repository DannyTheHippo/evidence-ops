import { chunkIdToPointId } from '../../../eval/qdrant/qdrant-point-id.util';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHUNK_ID_A = 'a'.repeat(64);
const CHUNK_ID_B = `b${'a'.repeat(63)}`;

describe('chunkIdToPointId', () => {
  it('should be deterministic for the same chunk id', () => {
    expect(chunkIdToPointId(CHUNK_ID_A)).toBe(chunkIdToPointId(CHUNK_ID_A));
  });

  it('should produce a UUID-shaped string', () => {
    expect(chunkIdToPointId(CHUNK_ID_A)).toMatch(UUID_PATTERN);
  });

  it('should map distinct chunk ids to distinct point ids', () => {
    expect(chunkIdToPointId(CHUNK_ID_A)).not.toBe(chunkIdToPointId(CHUNK_ID_B));
  });

  it('should throw on a chunk id shorter than 64 hex characters', () => {
    expect(() => chunkIdToPointId('a'.repeat(63))).toThrow();
  });

  it('should throw on a chunk id longer than 64 hex characters', () => {
    expect(() => chunkIdToPointId('a'.repeat(65))).toThrow();
  });

  it('should throw on uppercase hex characters', () => {
    expect(() => chunkIdToPointId('A'.repeat(64))).toThrow();
  });

  it('should throw on non-hex characters', () => {
    expect(() => chunkIdToPointId(`g${'a'.repeat(63)}`)).toThrow();
  });

  it('should throw on an empty string', () => {
    expect(() => chunkIdToPointId('')).toThrow();
  });
});
