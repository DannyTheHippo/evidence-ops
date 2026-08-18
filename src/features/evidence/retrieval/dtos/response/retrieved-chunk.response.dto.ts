import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { EvidenceLocator } from '../../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';

/** A hybrid-retrieval hit, joined back to its owning version's hash by `EvidenceRetrievalService`
 *  — see that service's doc comment. No score or relevance field: `retrieve()` discards it. */
export class RetrievedChunkResponseDto {
  @Expose()
  @ApiProperty({
    example: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    description: 'Content-addressed chunk identifier.',
  })
  chunkId: string;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b9',
    description: 'Identifier of the document version this chunk belongs to.',
  })
  docVersionId: string;

  @Expose()
  @ApiProperty({
    example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85',
    description: "sha256 of the owning document version's bytes — what a citation pins.",
  })
  sha256: string;

  @Expose()
  @ApiProperty({
    example: 'The cap rate for Northgate Business Park is approximately 6.10%.',
    description: 'Chunk text, exactly as stored at ingestion.',
  })
  text: string;

  @Expose()
  @ApiProperty({
    example: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
    description: "Where this chunk's text came from in the source document.",
  })
  locator: EvidenceLocator;
}
