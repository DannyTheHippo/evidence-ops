import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { RetrievedChunkResponseDto } from './retrieved-chunk.response.dto';

/**
 * Envelope for `GET /retrieval/search` — `hasMore` rather than a total. There is no cheap total
 * here: paging applies after fusion, the score floor, and withdrawn-version filtering, all of
 * which can drop a different number of hits between two identical calls, so a match count would
 * have to be computed fresh per request and would still disagree run to run. `hasMore` answers
 * only "is there a next page", and is itself best-effort for the same reason.
 */
export class SearchEvidenceResponseDto {
  @Expose()
  docs: RetrievedChunkResponseDto[];

  @Expose()
  @ApiProperty({
    example: true,
    description:
      'Whether another page of results exists beyond this one. Best-effort, not exact: paging ' +
      'happens after fusion, the score floor, and withdrawn-version filtering, so this can read ' +
      'true even when a stricter filter leaves the wider pool with nothing left to page into, ' +
      'and page boundaries are not guaranteed stable between two identical calls.',
  })
  hasMore: boolean;
}
