import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { MeResponseDto } from './me.response.dto';

export class AuthTokenResponseDto {
  @Expose()
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'Bearer JWT for authenticated requests.',
  })
  accessToken: string;

  @Expose()
  @Type(() => MeResponseDto)
  @ApiProperty({ type: () => MeResponseDto })
  user: MeResponseDto;
}
