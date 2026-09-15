import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsOptional, IsString } from 'class-validator';
import {
  AUDIT_EVENT_ORIGINS,
  type AuditEventOrigin,
} from '../../../../../database/schemas/audit/audit-event/audit-event.schema';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { IsAfter } from '../../../../../shared/decorators/is-after.decorator';
import { IsIsoInstant } from '../../../../../shared/decorators/is-iso-instant.decorator';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

// `actor` deliberately excluded: it serializes as an unresolved actor ObjectId
// (`AuditEventsService.toResult`), so ordering by it groups rows by an opaque id, not by the
// person behind it — that grouping is a filter this DTO does not offer yet, not a sort.
//
// `timestamp` deliberately excluded alongside `createdAt`: both fields exist and both are on the
// wire, but `audit_events_tenantId_createdAt` is this collection's only non-`_id` index.
// Allowlisting `timestamp` needs its own `{tenantId, timestamp}` index first.
export const AUDIT_EVENT_SORT_FIELDS = ['createdAt', 'action', 'origin'] as const;
export type AuditEventSortField = (typeof AUDIT_EVENT_SORT_FIELDS)[number];

export const DEFAULT_AUDIT_EVENT_SORT_FIELD: AuditEventSortField = 'createdAt';
export const DEFAULT_AUDIT_EVENT_SORT_DIRECTION: SortDirection = 'desc';

// actorId is deliberately not a filter here — deferred until a consumer needs it (see the
// feature's plan note); adding it later is additive, not a breaking change to this DTO.
export class ListAuditEventsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'approvals.decided',
    description: 'Exact audit action to filter by.',
    required: false,
  })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiProperty({
    example: 'Approval',
    description: 'Exact subject entity type to filter by.',
    required: false,
  })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description: 'Exact subject entity id to filter by.',
    required: false,
  })
  @IsOptional()
  @IsMongoId()
  entityId?: string;

  @ApiProperty({
    example: 'mcp',
    enum: AUDIT_EVENT_ORIGINS,
    description:
      "Exact origin to filter by: 'mcp' for an AI client holding a PAT, 'api' otherwise.",
    required: false,
  })
  @IsOptional()
  @IsIn(AUDIT_EVENT_ORIGINS)
  origin?: AuditEventOrigin;

  @ApiProperty({
    example: 'authz-denied',
    description: 'Exact refusal reason to filter by, matching mcp.tool_call.refused rows.',
    required: false,
  })
  @IsOptional()
  @IsString()
  refusalReason?: string;

  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description:
      'Only rows created at or after this instant. ISO-8601 instant with date, time and offset ' +
      '(`Z` or `±hh:mm`), as `toISOString()` emits.',
    required: false,
  })
  @IsOptional()
  @IsIsoInstant()
  from?: string;

  @ApiProperty({
    example: '2026-08-01T00:00:00.000Z',
    description:
      'Only rows created strictly before this instant; must be later than from. ISO-8601 ' +
      'instant with date, time and offset (`Z` or `±hh:mm`), as `toISOString()` emits.',
    required: false,
  })
  @IsOptional()
  @IsIsoInstant()
  @IsAfter('from')
  to?: string;

  @ApiProperty({
    example: 'createdAt',
    enum: AUDIT_EVENT_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(AUDIT_EVENT_SORT_FIELDS)
  sort?: AuditEventSortField;

  @ApiProperty({
    example: 'desc',
    enum: SORT_DIRECTIONS,
    description: 'Sort direction. Defaults to desc.',
    required: false,
  })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  sortDir?: SortDirection;
}
