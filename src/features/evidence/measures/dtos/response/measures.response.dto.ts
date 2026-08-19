import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class MeasuresResponseDto {
  @Expose()
  @ApiProperty({
    example: 42,
    description:
      'Completed answers for this tenant — the denominator every other figure on this page is ' +
      'read against.',
  })
  answersCompleted: number;

  @Expose()
  @ApiProperty({
    example: 37,
    description:
      "Completed answers whose outcome is 'answered'. Verified by construction, not by a second " +
      "check: the grounding gate persists 'answered' only once every cited claim survives quote " +
      'verification against the actual chunk bytes — an answer with every citation dropped is ' +
      "persisted as 'insufficient_evidence' instead, never left as a citation-less 'answered'.",
  })
  answersWithVerifiedCitations: number;

  @Expose()
  @ApiProperty({ example: 12, description: 'Every conflict ever detected for this tenant.' })
  conflictsSurfaced: number;

  @Expose()
  @ApiProperty({ example: 9, description: "Conflicts whose status is 'resolved'." })
  conflictsResolved: number;

  @Expose()
  @ApiProperty({
    example: 3.4,
    nullable: true,
    description:
      'Mean count of distinct EvidenceChunk.documentId retrieved per completed answer. null, ' +
      'never 0, when answersCompleted is 0 — 0 would assert this was measured and came out zero, ' +
      'a different and false claim.',
  })
  meanEvidenceDocumentsPerAnswer: number | null;

  @Expose()
  @ApiProperty({
    example: 4200,
    nullable: true,
    description:
      'Median of (updatedAt - createdAt) in milliseconds over completed answers. null, never 0, ' +
      'when answersCompleted is 0.',
  })
  medianAnswerLatencyMs: number | null;

  @Expose()
  @ApiProperty({
    example: 9800,
    nullable: true,
    description:
      'p95 of (updatedAt - createdAt) in milliseconds over completed answers. null, never 0, ' +
      'when answersCompleted is 0.',
  })
  p95AnswerLatencyMs: number | null;
}
