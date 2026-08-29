import { ApiProperty } from '@nestjs/swagger';

/**
 * Documents the shape of one entry in a validation 400's `errors` array. Never constructed or
 * passed through `toResponseDto` — `RequestValidationException` builds the response body
 * directly — so it carries no `@Expose()`; it exists purely to register the shape in the
 * OpenAPI document.
 */
export class FieldValidationErrorResponseDto {
  @ApiProperty({
    example: 'ownerEmail',
    description: 'Fully-qualified, dot-joined path of the field that failed validation.',
  })
  field: string;

  @ApiProperty({
    example: 'ownerEmail must be an email',
    description: "The failed constraint's message, naming only the field's local property.",
  })
  message: string;
}

/**
 * Documents the response body of a validation-pipe 400. Never constructed or passed through
 * `toResponseDto` — `RequestValidationException` builds this shape directly — so it carries no
 * `@Expose()`; it exists purely to register the shape in the OpenAPI document.
 */
export class ValidationErrorResponseDto {
  @ApiProperty({ example: 400, description: 'HTTP status code.' })
  statusCode: number;

  @ApiProperty({ example: 'Bad Request', description: 'HTTP status text.' })
  error: string;

  @ApiProperty({
    example: 'ownerEmail must be an email; values.0.unit should not be empty',
    description: 'Every failed constraint, joined with "; ".',
  })
  message: string;

  @ApiProperty({
    type: [FieldValidationErrorResponseDto],
    description: 'Per-field breakdown of every failed constraint.',
  })
  errors: FieldValidationErrorResponseDto[];
}
