import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// `month` is 1-12, already range-checked by the caller before this runs.
function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

function isIsoInstant(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** Property constraint: the value must be an ISO-8601 instant in extended calendar form with a
 *  date, a time and an explicit offset (`Z` or `±hh:mm`) that `Date.parse` accepts.
 *  `Date.prototype.toISOString()` output always matches.
 *
 *  Fails CLOSED: week dates, ordinal dates, the basic format, a date with no time, a time with no
 *  offset, a day that does not exist on its month (leap years resolved correctly), an out-of-range
 *  clock component or offset, and any non-string value are all invalid — a value naming a real
 *  instant is the only thing that reaches a query. */
export function IsIsoInstant(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: 'isIsoInstant',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isIsoInstant(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be an ISO-8601 instant with a date, a time and an offset`;
        },
      },
    });
  };
}
