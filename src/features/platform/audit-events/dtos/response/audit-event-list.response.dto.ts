import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { AuditEventResponseDto } from './audit-event.response.dto';

/** Nameable `{ docs, count }` envelope for the audit log. */
export class AuditEventListResponseDto extends WithCountResponseDto<AuditEventResponseDto> {
  @Expose()
  @Type(() => AuditEventResponseDto)
  @ApiProperty({
    type: [AuditEventResponseDto],
    description: 'Audit log entries, most recent first.',
  })
  declare docs: AuditEventResponseDto[];
}
