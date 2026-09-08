import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { AttestationBundle } from '../../attestation.service';

/**
 * Every field a recipient needs to independently recompute `integrity.contentHash`: sorted-key
 * canonical JSON of this whole payload minus `integrity` itself, sha256'd. Nested unions (`subject`,
 * `claims`, `decisions`, `measures`, `integrity`) are typed `Object`/`[Object]` rather than given
 * their own nested response classes — `AnswerResponseDto.citations` follows the same shape — so
 * `toResponseDto`'s `excludeExtraneousValues` never strips a field one level down that has no
 * `@Expose()` of its own.
 */
export class AttestationBundleResponseDto {
  @Expose()
  @ApiProperty({ type: Number, example: 1, description: 'Attestation bundle schema version.' })
  schemaVersion: AttestationBundle['schemaVersion'];

  @Expose()
  @ApiProperty({
    type: String,
    example: 'answer',
    enum: ['answer', 'verification'],
    description: 'Whether this bundle exports an Answer or a Verification.',
  })
  kind: AttestationBundle['kind'];

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description: 'Id of the answer or verification this bundle exports.',
  })
  subjectId: string;

  @Expose()
  @ApiProperty({ example: 'tenant-a', description: "The subject's tenant." })
  tenantId: string;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: "The subject's own creation timestamp, not the time it was exported.",
  })
  producedAt: string;

  @Expose()
  @ApiProperty({
    type: Object,
    description:
      'The question text for an answer bundle, or the submitted claim list for a verification bundle.',
  })
  subject: AttestationBundle['subject'];

  @Expose()
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'answered',
    description:
      "The answer's outcome kind, or null for a verification bundle or an answer with no outcome.",
  })
  outcome: AttestationBundle['outcome'];

  @Expose()
  @ApiProperty({
    type: [Object],
    description:
      'Every claim considered for this subject, survived or dropped, each with its own citations ' +
      'and the checks that decided its verdict.',
  })
  claims: AttestationBundle['claims'];

  @Expose()
  @ApiProperty({
    type: [Object],
    description:
      'Human decisions behind the conflicts this subject touches; empty for a verification bundle.',
  })
  decisions: AttestationBundle['decisions'];

  @Expose()
  @ApiProperty({
    type: [Object],
    description: 'Measure definitions referenced by the chunks this subject cites.',
  })
  measures: AttestationBundle['measures'];

  @Expose()
  @ApiProperty({
    type: Object,
    description:
      'sha256 over the sorted-key canonical JSON of every other field in this bundle. Proves ' +
      'integrity for a recipient who already trusts the channel the hash arrived through, never ' +
      'authenticity — there is no signing key.',
  })
  integrity: AttestationBundle['integrity'];
}
