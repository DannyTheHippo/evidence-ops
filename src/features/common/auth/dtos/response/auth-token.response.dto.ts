import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { MeResponseDto } from './me.response.dto';

export class AuthTokenResponseDto {
  @Expose()
  @Type(() => MeResponseDto)
  @ApiProperty({ type: () => MeResponseDto })
  user: MeResponseDto;
}
