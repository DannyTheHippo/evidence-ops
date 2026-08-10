import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class WithCountResponseDto<T extends object> {
  @Expose()
  docs: T[];

  @Expose()
  @ApiProperty({
    example: 2,
    description: 'Total number of documents returned.',
  })
  count: number;
}
