import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { ApiKeyResponseDto } from './api-key.response.dto';

/** Nameable `{ docs, count }` envelope for the caller's API key list. */
export class ApiKeyListResponseDto extends WithCountResponseDto<ApiKeyResponseDto> {
  @Expose()
  @Type(() => ApiKeyResponseDto)
  @ApiProperty({ type: [ApiKeyResponseDto], description: "The caller's own API keys." })
  declare docs: ApiKeyResponseDto[];
}
