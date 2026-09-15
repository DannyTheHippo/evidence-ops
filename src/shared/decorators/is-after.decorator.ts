import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

function isLaterInstant(value: unknown, relatedValue: unknown): boolean {
  if (
    value === undefined ||
    value === null ||
    relatedValue === undefined ||
    relatedValue === null
  ) {
    return true;
  }
  if (typeof value !== 'string' || typeof relatedValue !== 'string') {
    return true;
  }

  const instant = Date.parse(value);
  const relatedInstant = Date.parse(relatedValue);
  if (Number.isNaN(instant) || Number.isNaN(relatedInstant)) {
    return false;
  }

  return instant > relatedInstant;
}

function isUnparseable(value: unknown): boolean {
  return typeof value === 'string' && Number.isNaN(Date.parse(value));
}

/** Cross-field constraint: this property must name a later instant than `property`. Skipped when
 *  either value is absent, so it composes with `@IsOptional()` on both ends. Fails CLOSED when
 *  either string does not parse as a date, with a message naming the unparseable value rather
 *  than the ordering. */
export function IsAfter(
  property: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: 'isAfter',
      target: target.constructor,
      propertyName: propertyKey as string,
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [relatedPropertyName] = args.constraints as [string];
          const relatedValue = (args.object as Record<string, unknown>)[relatedPropertyName];
          return isLaterInstant(value, relatedValue);
        },
        defaultMessage(args: ValidationArguments): string {
          const [relatedPropertyName] = args.constraints as [string];
          const relatedValue = (args.object as Record<string, unknown>)[relatedPropertyName];
          if (isUnparseable(args.value) || isUnparseable(relatedValue)) {
            return `${args.property} (${args.value}) and ${relatedPropertyName} (${String(relatedValue)}) must both be parseable instants`;
          }
          return `${args.property} (${args.value}) must be later than ${relatedPropertyName} (${String(relatedValue)})`;
        },
      },
    });
  };
}
