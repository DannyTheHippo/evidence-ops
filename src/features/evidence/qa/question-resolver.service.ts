import { Injectable } from '@nestjs/common';
import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import {
  type CanonicalEntityListing,
  CanonicalEntityService,
} from '../facts/canonical-entity.service';
import { findStatedPeriods } from '../facts/derive-period';
import { MeasuresService } from '../measures/measures.service';
import { containsNormalizedToken } from './entity-token-match';
import { extractNumericTokens } from './extract-numeric-tokens';
import { resolveQuestionEntity } from './scope-conflict-to-question';

/** A confirmed measure projected to the three fields whole-token matching needs — `slug` is the
 *  join key `MeasureDefinition.id` carries, never `measureId`, mirroring the same projection
 *  `ClaimVerificationService.toVerifierMeasures` makes for the same reason. */
export interface ResolverMeasure {
  readonly slug: string;
  readonly label: string;
  readonly aliases: readonly string[];
}

/**
 * A question resolves only when it pins down exactly one registered entity, exactly one confirmed
 * measure, and at most one stated period whose own numbers account for every number the question
 * states — anything else is `unresolved`, and `reason` names which fork refused. There is no
 * partial resolution: a caller must never build a ledger lookup out of one resolved field and a
 * guessed other.
 */
export type QuestionResolution =
  | {
      readonly kind: 'resolved';
      readonly entity: string;
      readonly measure: string;
      readonly period?: string;
    }
  | {
      readonly kind: 'unresolved';
      readonly reason:
        | 'no-entity'
        | 'ambiguous-entity'
        | 'no-measure'
        | 'ambiguous-measure'
        | 'ambiguous-period'
        | 'numeric-constraint';
    };

/**
 * Pure resolution over already-loaded registries — no model call, no database access. Every fork
 * fails CLOSED toward `unresolved`: a question this function cannot pin to a single cell must
 * never guess one, because a wrong resolution answers silently from the wrong cell.
 *
 * Entity naming is {@link resolveQuestionEntity}'s own whole-token, alias-aware match; this
 * function only adds the `no-entity`/`ambiguous-entity` distinction that function's `null` result
 * collapses. Measure matching applies the same whole-token rule via {@link
 * containsNormalizedToken} against every measure's label and aliases. A stated period beyond the
 * single one this resolves narrows nothing by itself — {@link findStatedPeriods} reads a question
 * in sentence semantics, where a bare plausible year counts, so the numeric-constraint check below
 * is what catches a question naming a number no stated period explains (a bare threshold like
 * "above 6%", or a quarter number a period matcher never accepted, such as "Q5 2024").
 */
export function resolveQuestion(
  questionText: string,
  entities: readonly CanonicalEntityListing[],
  measures: readonly ResolverMeasure[],
): QuestionResolution {
  const normalizedQuestion = normalizeEntityName(questionText);

  const entity = resolveQuestionEntity(questionText, entities);
  if (!entity) {
    const anyEntityNamed = entities.some((candidate) =>
      [candidate.canonicalNameNormalized, ...candidate.aliasesNormalized].some((name) =>
        containsNormalizedToken(normalizedQuestion, name),
      ),
    );
    return { kind: 'unresolved', reason: anyEntityNamed ? 'ambiguous-entity' : 'no-entity' };
  }

  const matchedMeasureSlugs = new Set(
    measures
      .filter((measure) =>
        [measure.label, ...measure.aliases].some((phrase) =>
          containsNormalizedToken(normalizedQuestion, normalizeEntityName(phrase)),
        ),
      )
      .map((measure) => measure.slug),
  );
  if (matchedMeasureSlugs.size === 0) {
    return { kind: 'unresolved', reason: 'no-measure' };
  }
  if (matchedMeasureSlugs.size > 1) {
    return { kind: 'unresolved', reason: 'ambiguous-measure' };
  }
  const [measure] = matchedMeasureSlugs;

  const periods = findStatedPeriods(questionText);
  if (periods.length > 1) {
    return { kind: 'unresolved', reason: 'ambiguous-period' };
  }

  const explainedNumbers = new Set(
    periods.length === 1 ? extractNumericTokens(periods[0].key) : [],
  );
  const hasUnexplainedNumber = extractNumericTokens(questionText).some(
    (token) => !explainedNumbers.has(token),
  );
  if (hasUnexplainedNumber) {
    return { kind: 'unresolved', reason: 'numeric-constraint' };
  }

  return {
    kind: 'resolved',
    entity: entity.canonicalName,
    measure,
    ...(periods.length === 1 ? { period: periods[0].key } : {}),
  };
}

/**
 * Loads a tenant's canonical entity registry and confirmed measures, then delegates to {@link
 * resolveQuestion}. The one deterministic entry point `LedgerAnswerService` calls before ever
 * touching the ledger — resolving nothing here means the synthesis path runs instead, never a
 * guessed cell.
 */
@Injectable()
export class QuestionResolverService {
  constructor(
    private readonly canonicalEntityService: CanonicalEntityService,
    private readonly measuresService: MeasuresService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(QuestionResolverService.name);
  }

  async resolve(questionText: string, tenantId: string): Promise<QuestionResolution> {
    const [entities, definitions] = await Promise.all([
      this.canonicalEntityService.listCanonicalEntities(tenantId),
      this.measuresService.listConfirmedDefinitions(tenantId),
    ]);

    const measures: ResolverMeasure[] = definitions.map((definition) => ({
      slug: definition.id,
      label: definition.label,
      aliases: definition.aliases,
    }));

    const resolution = resolveQuestion(questionText, entities, measures);
    if (resolution.kind === 'unresolved') {
      this.logger.debug(`Question unresolved for tenant '${tenantId}': ${resolution.reason}`);
    }
    return resolution;
  }
}
