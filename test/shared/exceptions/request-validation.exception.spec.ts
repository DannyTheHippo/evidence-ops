import { HttpStatus } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import {
  flattenValidationErrors,
  RequestValidationException,
  type FieldValidationError,
} from '../../../src/shared/exceptions/request-validation.exception';

const buildError = (overrides: Partial<ValidationError>): ValidationError =>
  ({ property: 'field', ...overrides }) as unknown as ValidationError;

describe('flattenValidationErrors', () => {
  it('should return one entry for a single failed constraint', () => {
    const errors = [
      buildError({ property: 'email', constraints: { isEmail: 'email must be an email' } }),
    ];

    expect(flattenValidationErrors(errors)).toEqual<FieldValidationError[]>([
      { field: 'email', message: 'email must be an email' },
    ]);
  });

  it('should return one entry per constraint when a property fails more than one', () => {
    const errors = [
      buildError({
        property: 'skip',
        constraints: {
          isInt: 'skip must be an integer number',
          min: 'skip must not be less than 0',
        },
      }),
    ];

    expect(flattenValidationErrors(errors)).toEqual<FieldValidationError[]>([
      { field: 'skip', message: 'skip must be an integer number' },
      { field: 'skip', message: 'skip must not be less than 0' },
    ]);
  });

  it('should dot-join a nested DTO error onto its parent property', () => {
    const errors = [
      buildError({
        property: 'owner',
        children: [
          buildError({ property: 'email', constraints: { isEmail: 'email must be an email' } }),
        ],
      }),
    ];

    expect(flattenValidationErrors(errors)).toEqual<FieldValidationError[]>([
      { field: 'owner.email', message: 'email must be an email' },
    ]);
  });

  it('should use the array index as its own path segment for an array-item error', () => {
    const errors = [
      buildError({
        property: 'values',
        children: [
          buildError({
            property: '0',
            children: [
              buildError({
                property: 'unit',
                constraints: { isNotEmpty: 'unit should not be empty' },
              }),
            ],
          }),
        ],
      }),
    ];

    expect(flattenValidationErrors(errors)).toEqual<FieldValidationError[]>([
      { field: 'values.0.unit', message: 'unit should not be empty' },
    ]);
  });

  it('should contribute nothing for a node with neither constraints nor children', () => {
    const errors = [buildError({ property: 'ghost' })];

    expect(flattenValidationErrors(errors)).toEqual([]);
  });

  it('should return no entries for an empty input array', () => {
    expect(flattenValidationErrors([])).toEqual([]);
  });
});

describe('RequestValidationException', () => {
  it('should build a 400 response body with a field breakdown and a qualified joined message', () => {
    const errors = [
      buildError({
        property: 'ownerEmail',
        constraints: { isEmail: 'ownerEmail must be an email' },
      }),
      buildError({
        property: 'values',
        children: [
          buildError({
            property: '0',
            children: [
              buildError({
                property: 'unit',
                constraints: { isNotEmpty: 'unit should not be empty' },
              }),
            ],
          }),
        ],
      }),
    ];

    const exception = new RequestValidationException(errors);

    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(exception.getResponse()).toEqual({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: 'ownerEmail must be an email; values.0.unit should not be empty',
      errors: [
        { field: 'ownerEmail', message: 'ownerEmail must be an email' },
        { field: 'values.0.unit', message: 'unit should not be empty' },
      ],
    });
  });

  it('should prefix rather than rewrite a constraint message that does not lead with the local property name', () => {
    const errors = [
      buildError({
        property: 'owner',
        children: [
          buildError({ property: 'email', constraints: { custom: 'must look like an email' } }),
        ],
      }),
    ];

    const exception = new RequestValidationException(errors);

    expect(exception.getResponse()).toMatchObject({
      message: 'owner.email: must look like an email',
    });
  });

  it('should build an empty message and an empty errors array from an empty input', () => {
    const exception = new RequestValidationException([]);

    expect(exception.getResponse()).toEqual({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: '',
      errors: [],
    });
  });
});
