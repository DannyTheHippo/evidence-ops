import { validate } from 'class-validator';
import { IsAfter } from '../../../src/shared/decorators/is-after.decorator';

class RangeFixture {
  from?: string;

  @IsAfter('from')
  to?: string;
}

function buildFixture(from: string | undefined, to: string | undefined): RangeFixture {
  const fixture = new RangeFixture();
  fixture.from = from;
  fixture.to = to;
  return fixture;
}

describe('IsAfter', () => {
  it('should pass when to is later than from', async () => {
    const errors = await validate(
      buildFixture('2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
    );

    expect(errors).toHaveLength(0);
  });

  it('should fail when to equals from', async () => {
    const errors = await validate(
      buildFixture('2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toEqual({
      isAfter: 'to (2026-07-01T00:00:00.000Z) must be later than from (2026-07-01T00:00:00.000Z)',
    });
  });

  it('should fail when to is earlier than from', async () => {
    const errors = await validate(
      buildFixture('2026-08-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toEqual({
      isAfter: 'to (2026-07-01T00:00:00.000Z) must be later than from (2026-08-01T00:00:00.000Z)',
    });
  });

  it.each([
    ['to', '2026-07-01T00:00:00.000Z', '2026-W27'],
    ['from', '20260701', '2026-08-01T00:00:00.000Z'],
    ['both', '2026-185', '2026-07-01T25:00:00Z'],
  ])(
    'should fail with an unparseable-value message when %s does not parse',
    async (_side, from, to) => {
      const errors = await validate(buildFixture(from, to));

      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toEqual({
        isAfter: `to (${to}) and from (${from}) must both be parseable instants`,
      });
    },
  );

  it('should pass when from is absent', async () => {
    const errors = await validate(buildFixture(undefined, '2026-08-01T00:00:00.000Z'));

    expect(errors).toHaveLength(0);
  });

  it('should pass when to is absent', async () => {
    const errors = await validate(buildFixture('2026-07-01T00:00:00.000Z', undefined));

    expect(errors).toHaveLength(0);
  });
});
