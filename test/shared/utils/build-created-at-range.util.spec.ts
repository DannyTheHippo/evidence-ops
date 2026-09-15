import { buildCreatedAtRange } from '../../../src/shared/utils/build-created-at-range.util';

describe('buildCreatedAtRange', () => {
  it('should return an empty object when neither bound is given', () => {
    expect(buildCreatedAtRange(undefined, undefined)).toEqual({});
  });

  it('should return only $gte when only from is given', () => {
    expect(buildCreatedAtRange('2026-07-01T00:00:00.000Z', undefined)).toEqual({
      createdAt: { $gte: new Date('2026-07-01T00:00:00.000Z') },
    });
  });

  it('should return only $lt when only to is given', () => {
    expect(buildCreatedAtRange(undefined, '2026-08-01T00:00:00.000Z')).toEqual({
      createdAt: { $lt: new Date('2026-08-01T00:00:00.000Z') },
    });
  });

  it('should return both $gte and $lt when both bounds are given', () => {
    expect(buildCreatedAtRange('2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')).toEqual({
      createdAt: {
        $gte: new Date('2026-07-01T00:00:00.000Z'),
        $lt: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
  });
});
