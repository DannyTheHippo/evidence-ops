import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsMongoId } from 'class-validator';
import { MAX_PAGINATION_LIMIT } from '../../../../../shared/constants/pagination-defaults.constant';

export class LookupDocumentVersionsRequestDto {
  @ApiProperty({
    example: ['65f1c2e4a1b2c3d4e5f6a7b9', '65f1c2e4a1b2c3d4e5f6a7ba'],
    description:
      'Document version ids to resolve, comma-separated in a single querystring value or ' +
      'repeated (versionIds=a&versionIds=b) — both arrive at this handler the same way.',
    type: [String],
  })
  // Express parses a repeated `versionIds=a&versionIds=b` into an array already; only the
  // comma-separated single-value form needs splitting here.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsArray()
  @ArrayMaxSize(MAX_PAGINATION_LIMIT)
  @IsMongoId({ each: true })
  versionIds: string[];
}
