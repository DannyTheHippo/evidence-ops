import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { EvidenceLocator } from '../../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';

/**
 * What a citation actually points at — the stored `evidence_chunks` rows, not a re-parse of the
 * source document (see `DocumentsService.listVersionChunks`'s doc comment for why). Recorded
 * bounds a reader must not mistake this for a faithful page render: chunk granularity may span
 * multiple source pages, ~12% overlap between adjacent chunks means some text repeats, and any
 * element quarantined during ingestion is absent from this list entirely.
 */
export class EvidenceChunkResponseDto {
  @Expose()
  @ApiProperty({
    example: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    description: 'Content-addressed chunk identifier.',
  })
  id: string;

  @Expose()
  @ApiProperty({
    example: 'The cap rate for Northgate Business Park is approximately 6.10%.',
    description: 'Chunk text, exactly as stored at ingestion.',
  })
  text: string;

  @Expose()
  @ApiProperty({
    example: 128,
    description: 'Token count of this chunk, as measured at ingestion.',
  })
  tokenCount: number;

  @Expose()
  @ApiProperty({
    example: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
    description: "Where this chunk's text came from in the source document.",
  })
  locator: EvidenceLocator;
}
