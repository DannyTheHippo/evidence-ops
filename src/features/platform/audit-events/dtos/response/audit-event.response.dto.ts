import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class AuditEventSubjectResponseDto {
  @Expose()
  @ApiProperty({ example: 'Approval', description: 'The audited entity type.' })
  entityType: string;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b9',
    description: 'The audited entity id.',
  })
  entityId: string;
}

export class AuditEventResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'AuditEvent identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7c0',
    description: 'Id of the account that performed the audited action.',
  })
  actor: string;

  @Expose()
  @ApiProperty({ example: 'approvals.decided', description: 'The audited action.' })
  action: string;

  @Expose()
  @Type(() => AuditEventSubjectResponseDto)
  @ApiProperty({ type: () => AuditEventSubjectResponseDto })
  subject: AuditEventSubjectResponseDto;

  @Expose()
  @ApiProperty({
    example: '2026-07-02T00:00:00.000Z',
    description: 'When the audited action occurred.',
  })
  timestamp: Date;

  @Expose()
  @ApiProperty({
    example: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
    description: "The originating request's correlation id.",
  })
  correlationId: string;

  @Expose()
  @ApiProperty({ example: '2026-07-02T00:00:00.000Z', description: 'Row creation timestamp.' })
  createdAt: Date;
}
