import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { EvidenceLocator } from '../../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';

/** A hybrid-retrieval hit, joined back to its owning document and version by
 *  `EvidenceRetrievalService` — see that service's doc comment. */
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

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description:
      'Identifier of the document this chunk belongs to — distinct from docVersionId, which ' +
      'identifies one version of it.',
  })
  documentId: string;

  @Expose()
  @ApiProperty({
    example: 'Northgate Business Park — Q3 Rent Roll',
    description: "The owning document's title, for display alongside a citation.",
  })
  documentTitle: string;

  @Expose()
  @ApiProperty({
    example: 0.0164,
    description:
      'Fused hybrid-retrieval relevance score (reciprocal rank fusion across the lexical and ' +
      'vector pipelines). Not a 0-1 similarity: it is bounded above by a small constant ' +
      '(2 pipelines / (60 + best rank 1), about 0.0328 today) that shrinks as the query widens, ' +
      "so rendering it as a percentage misrepresents it — use it only to rank this response's " +
      "hits against each other, never against another query's hits or a fixed threshold.",
  })
  score: number;
}
