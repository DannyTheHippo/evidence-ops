import { HttpException, HttpStatus } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

/** One failed constraint, keyed by its fully-qualified, dot-joined field path. */
export interface FieldValidationError {
  field: string;
  message: string;
}

/**
 * Flattens class-validator's `ValidationError` tree into one entry per failed constraint.
 * A nested DTO or an array item surfaces as `ValidationError.children`; this walks them
 * recursively, dot-joining each level onto the parent path and using the array index itself
 * as a path segment (`values.0.unit`) rather than a special array syntax. A node with neither
 * `constraints` nor `children` contributes nothing.
 */
export const flattenValidationErrors = (
  errors: ValidationError[],
  parentPath = '',
): FieldValidationError[] =>
  errors.flatMap((error) => {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    const ownErrors = error.constraints
      ? Object.values(error.constraints).map((message) => ({ field, message }))
      : [];
    const childErrors = error.children?.length
      ? flattenValidationErrors(error.children, field)
      : [];

    return [...ownErrors, ...childErrors];
  });

/**
 * class-validator's constraint messages name only the local property (e.g. "unit should not be
 * empty"), which is ambiguous once that property is nested. This requalifies the message with
 * the field's full dotted path ("values.0.unit should not be empty") for use in a single joined
 * string; a message that does not lead with the local property name is prefixed instead of
 * rewritten.
 */
const qualifyMessage = ({ field, message }: FieldValidationError): string => {
  const localProperty = field.slice(field.lastIndexOf('.') + 1);
  return message.startsWith(localProperty)
    ? field + message.slice(localProperty.length)
    : `${field}: ${message}`;
};

/**
 * Thrown by the global `ValidationPipe`'s `exceptionFactory` in place of Nest's default
 * `BadRequestException`. The response body keeps `statusCode`/`error`/`message` in the same
 * shape every other 400 uses — `message` stays a single string, each failed constraint joined
 * with `'; '` — and adds `errors`, a per-field breakdown a caller can render without parsing
 * that string. `GlobalExceptionFilter` spreads an object response body unchanged, so `errors`
 * reaches the client as-is.
 */
export class RequestValidationException extends HttpException {
  constructor(validationErrors: ValidationError[]) {
    const errors = flattenValidationErrors(validationErrors);
    const message = errors.map(qualifyMessage).join('; ');

    super(
      { statusCode: HttpStatus.BAD_REQUEST, error: 'Bad Request', message, errors },
      HttpStatus.BAD_REQUEST,
    );
  }
}
