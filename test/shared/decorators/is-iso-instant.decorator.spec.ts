import { validate } from 'class-validator';
import { IsIsoInstant } from '../../../src/shared/decorators/is-iso-instant.decorator';

class InstantFixture {
  @IsIsoInstant()
  from?: unknown;
}

function buildFixture(from: unknown): InstantFixture {
  const fixture = new InstantFixture();
  fixture.from = from;
  return fixture;
}

describe('IsIsoInstant', () => {
  it.each([
    ['a UTC instant with milliseconds', '2026-07-01T00:00:00.000Z'],
    ['a UTC instant with seconds', '2026-07-01T00:00:00Z'],
    ['a minute-precision instant with a positive offset', '2026-07-01T00:00+02:00'],
    ['an instant with a negative offset', '2026-07-01T23:59:59.5-05:30'],
    ['a leap day on an existing leap year', '2024-02-29T00:00:00Z'],
    ['a leap day on a century divisible by 400', '2000-02-29T00:00:00Z'],
    ['the last second of a day', '2026-07-01T23:59:59Z'],
    ['the last day of a 28-day February', '2026-02-28T00:00:00Z'],
    ['the last day of a 30-day month', '2026-04-30T00:00:00Z'],
    ['the last day of a 31-day month', '2026-01-31T00:00:00Z'],
    ['the ISO end-of-day form', '2026-07-01T24:00:00Z'],
  ])('should pass for %s', async (_label, value) => {
    const errors = await validate(buildFixture(value));

    expect(errors).toHaveLength(0);
  });

  it.each([
    ['a week date', '2026-W27'],
    ['a week date with a weekday', '2026-W27-1'],
    ['an ordinal date', '2026-185'],
    ['a basic-format date', '20260701'],
    ['a basic-format instant', '20260701T000000Z'],
    ['a date with no time', '2026-07-01'],
    ['a time with no offset', '2026-07-01T00:00:00'],
    ['an unparseable hour', '2026-07-01T25:00:00Z'],
    ['an unparseable month', '2026-13-01T00:00:00Z'],
    ['a day past February in a non-leap year', '2026-02-29T00:00:00Z'],
    ['a day past February in the wrong leap-adjacent year', '2025-02-29T00:00:00Z'],
    ['a leap day on a century not divisible by 400 (1900)', '1900-02-29T00:00:00Z'],
    ['a leap day on a century not divisible by 400 (2100)', '2100-02-29T00:00:00Z'],
    ['a day the month never reaches (30 in February)', '2026-02-30T00:00:00Z'],
    ['a day the month never reaches (31 in April)', '2026-04-31T00:00:00Z'],
    ['a minute of 60', '2026-07-01T00:60:00Z'],
    ['a second of 60', '2026-07-01T00:00:60Z'],
    ['an end-of-day hour with a nonzero minute', '2026-07-01T24:01:00Z'],
    ['an end-of-day hour with a nonzero second', '2026-07-01T24:00:01Z'],
    ['an offset with an out-of-range hour', '2026-07-01T00:00:00+24:00'],
    ['an empty string', ''],
    ['a number', 1782864000000],
    ['a Date object', new Date('2026-07-01T00:00:00.000Z')],
    ['null', null],
    ['undefined', undefined],
  ])('should fail for %s', async (_label, value) => {
    const errors = await validate(buildFixture(value));

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toEqual({
      isIsoInstant: 'from must be an ISO-8601 instant with a date, a time and an offset',
    });
  });
});
