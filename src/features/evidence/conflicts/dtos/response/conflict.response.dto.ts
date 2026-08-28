import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { ConflictStatus } from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import { CONFLICT_STATUSES } from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import type { EvidenceLocator } from '../../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { FactKey } from '../../../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { ResolveConflictProposal } from '../../resolve-conflict-policy';

/** Plain shape, not a nested response-DTO class with its own `@Expose()`s: `ConflictsService`
 *  builds this object field-for-field from each disagreeing `ExtractedFact` (never spreads it) —
 *  see `ApprovalSubjectShape`'s identical reasoning in `approval.response.dto.ts`. One entry per
 *  `ConflictResponseDto.factIds` element, in the same order, so a human choosing a winner can line
 *  up a `factId` with the value and provenance it produced — except when `unscorable` is true,
 *  where a `factIds` entry with no resolving `ExtractedFact` is simply omitted rather than
 *  breaking that pairing. */
export interface ConflictValueShape {
  factId: string;
  value: number;
  unit: string;
  sourceChunkId: string;
  documentVersionId: string;
  locator: EvidenceLocator;
  // True when `documentVersionId` currently carries `withdrawnAt` — the source file behind this
  // side of the disagreement is no longer at its source, though the fact itself (and this
  // conflict) is untouched: a reviewer weighing the two sides should know one is withdrawn, but
  // the conflict still needs a human resolution the same as any other open one.
  withdrawn: boolean;
}

export class ConflictResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Conflict identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
    description: 'The fact key every disagreeing ExtractedFact in this conflict shares.',
  })
  factKey: FactKey;

  @Expose()
  @ApiProperty({
    type: [String],
    description: 'Identifiers of the two or more disagreeing ExtractedFact documents.',
  })
  factIds: string[];

  @Expose()
  @ApiProperty({
    example: [
      {
        factId: '65f1c2e4a1b2c3d4e5f6a7b9',
        value: 5.25,
        unit: 'percent',
        sourceChunkId: 'chunk-xlsx',
        documentVersionId: '65f1c2e4a1b2c3d4e5f6a7c0',
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
        withdrawn: false,
      },
      {
        factId: '65f1c2e4a1b2c3d4e5f6a7ba',
        value: 6.1,
        unit: 'percent',
        sourceChunkId: 'chunk-prose',
        documentVersionId: '65f1c2e4a1b2c3d4e5f6a7c1',
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
        withdrawn: false,
      },
    ],
    description:
      "Every disagreeing ExtractedFact's value and provenance, in the same order as factIds — " +
      'what a human weighs to choose which one wins.',
  })
  values: ConflictValueShape[];

  @Expose()
  @ApiProperty({
    example: 0.0085,
    description: "Normalized disagreement magnitude between the group's values.",
  })
  magnitude: number;

  @Expose()
  @ApiProperty({
    example: 'ratio',
    description:
      "The unit magnitude is expressed in — the metric's canonicalUnit at detection time, not a " +
      'fixed unit for the collection. Distinguishes, for example, a cap-rate spread from a ' +
      'dollar spread, which would otherwise render as an identical bare number.',
  })
  magnitudeUnit: string;

  @Expose()
  @ApiProperty({ example: 'open', enum: CONFLICT_STATUSES, description: 'Conflict status.' })
  status: ConflictStatus;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Conflict creation timestamp.' })
  createdAt: Date;

  @Expose()
  @ApiProperty({
    example: false,
    description:
      "True when this conflict's packId/packVersion stamp does not match the deployed " +
      'ACTIVE_PACK_ID/ACTIVE_PACK_VERSION — a row detected under a superseded ontology may no ' +
      'longer match what the current ontology would compute today. Always present, independent ' +
      'of unscorable — the two are unrelated failure modes and a row can carry either, both, or ' +
      'neither. Never hidden: a stale row stays in the list, shown and labelled, rather than ' +
      'silently dropped.',
  })
  stale: boolean;

  @Expose()
  @ApiProperty({
    example: "Detected under pack 'cre' v1; the active pack is now 'cre' v2.",
    description:
      'Present only when stale is true — which pack detected this row versus which is active now.',
    required: false,
  })
  staleReason?: string;

  @Expose()
  @ApiProperty({
    example: false,
    description:
      "True when one or more of this conflict's factIds no longer resolve to an ExtractedFact " +
      "— the document that produced them was deleted after this conflict left 'open' status, so " +
      "the delete cascade's fact removal was never mirrored back onto this conflict's factIds. " +
      'The row is still returned rather than dropped from the list: a reviewer must be able to ' +
      'see that the conflict once existed and that its evidence is now gone. proposedWinnerFactId, ' +
      'ruleFired and explanation are all absent when this is true — no survivorship policy runs ' +
      'over a fact set already known to be incomplete.',
  })
  unscorable: boolean;

  @Expose()
  @ApiProperty({
    example: '1 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.',
    description: 'Present only when unscorable is true — why this conflict could not be evaluated.',
    required: false,
  })
  unscorableReason?: string;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b9',
    description:
      'The ExtractedFact id the survivorship policy proposes as the winner, computed fresh on ' +
      "every read. Absent when ruleFired is 'none' (the policy has no proposal to make) or when " +
      'unscorable is true.',
    required: false,
  })
  proposedWinnerFactId?: string;

  @Expose()
  @ApiProperty({
    example: 'authority',
    enum: ['authority', 'recency', 'none'],
    description:
      "Which survivorship rule produced this proposal, or 'none' if the policy declined to " +
      'propose a winner. Absent when unscorable is true. Never decides anything on its own — a ' +
      'human still resolves the conflict.',
    required: false,
  })
  ruleFired?: ResolveConflictProposal['ruleFired'];

  @Expose()
  @ApiProperty({
    example:
      "Fact 65f1c2e4a1b2c3d4e5f6a7b9's source class 'crm-export' outranks 'memo' in the " +
      'configured authorityOrder.',
    description:
      "Human-readable justification for ruleFired/proposedWinnerFactId's value. Absent when " +
      'unscorable is true.',
    required: false,
  })
  explanation?: string;
}
