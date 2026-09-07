import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

/** Paging only — the entity roster is ordered by name and carries no filters of its own. Declared
 *  as its own class rather than reusing `PaginationRequestDto` directly so the route's Swagger
 *  entry names the shape it accepts, and so a filter can be added here without touching a shared
 *  DTO every paginated route in the API depends on. */
export class ListLedgerEntitiesRequestDto extends PaginationRequestDto {}
