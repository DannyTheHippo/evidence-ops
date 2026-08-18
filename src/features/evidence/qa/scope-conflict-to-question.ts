import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { ConflictedFactGroup } from '../conflicts/conflicts.service';
import type { CanonicalEntityListing } from '../facts/canonical-entity.service';

/** Whether `normalizedName` occurs in `normalizedQuestion` as a whole token — never a bare
 *  substring, so "gate" does not match inside "northgate". A occurrence counts as whole-token when
 *  neither the character immediately before nor immediately after it is itself a letter or digit,
 *  which also makes trailing question-text punctuation ("...Business Park?") a valid boundary
 *  without this function stripping or otherwise rewriting the punctuation itself. Both arguments
 *  are already `normalizeEntityName`-normalized (trim, collapse internal whitespace, lowercase), so
 *  a multi-word `normalizedName`'s internal spaces line up with the question's own collapsed
 *  spaces. */
function normalizedNameOccursInQuestion(
  normalizedQuestion: string,
  normalizedName: string,
): boolean {
  if (!normalizedName) {
    return false;
  }
  const isWordChar = (char: string | undefined): boolean =>
    char !== undefined && /[a-z0-9]/.test(char);

  let searchFrom = 0;
  for (;;) {
    const index = normalizedQuestion.indexOf(normalizedName, searchFrom);
    if (index === -1) {
      return false;
    }
    const before = normalizedQuestion[index - 1];
    const after = normalizedQuestion[index + normalizedName.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }
    searchFrom = index + 1;
  }
}

/**
 * The single canonical entity `questionText` names, or `null` when that cannot be determined
 * safely. An entity counts as named when its normalized canonical name or one of its normalized
 * aliases occurs in the normalized question on whole-token boundaries — exact and alias-only, never
 * fuzzy or edit-distance, mirroring `CanonicalEntityService`'s own refusal to guess (and for the
 * same reason: a fuzzy match here would fabricate an agreement between two properties that were
 * never actually the same).
 *
 * FAILS CLOSED: naming zero entities or naming more than one distinct entity both return `null`
 * rather than picking one. A question this function cannot pin to a single property must yield no
 * entity at all, not a guessed one.
 */
export function resolveQuestionEntity(
  questionText: string,
  canonicalEntities: readonly CanonicalEntityListing[],
): CanonicalEntityListing | null {
  const normalizedQuestion = normalizeEntityName(questionText);

  const namedEntities = canonicalEntities.filter((entity) =>
    [entity.canonicalNameNormalized, ...entity.aliasesNormalized].some((normalizedName) =>
      normalizedNameOccursInQuestion(normalizedQuestion, normalizedName),
    ),
  );

  const distinctCanonicalNames = new Set(
    namedEntities.map((entity) => entity.canonicalNameNormalized),
  );
  if (distinctCanonicalNames.size !== 1) {
    return null;
  }
  return namedEntities[0];
}

/** Filters `groups` to those whose `factKey.entity` normalizes to `entity`'s canonical name or one
 *  of its aliases. Exposed separately from {@link scopeConflictToQuestion} so `findEitherSideConflict`
 *  (`src/worker/activities.ts`) can narrow its own candidate groups by the question's resolved
 *  entity without going through the group-count fork `scopeConflictToQuestion` applies on top. */
export function filterGroupsByEntity(
  groups: readonly ConflictedFactGroup[],
  entity: CanonicalEntityListing,
): ConflictedFactGroup[] {
  const matchingNames = new Set([entity.canonicalNameNormalized, ...entity.aliasesNormalized]);
  return groups.filter((group) => matchingNames.has(normalizeEntityName(group.factKey.entity)));
}

/**
 * Narrows `groups` — a tenant's currently open conflict groups touching the retrieved evidence — to
 * the single group whose `factKey.entity` names the same property `questionText` asks about, or
 * returns `null` when that cannot be done safely. Entity naming and the fail-closed forks it
 * inherits are {@link resolveQuestionEntity}'s; this function adds one more fork on top: once a
 * single entity is resolved, exactly one group must belong to it (via {@link filterGroupsByEntity})
 * for a result to be returned.
 *
 * FAILS CLOSED at every fork, for the same reason `resolveQuestionEntity` does: this is an
 * attachment gate, not a measurement, and the caller (`groundingCheck` in `src/worker/activities.ts`)
 * already treats a `null` result as `insufficient_evidence` — abstaining here costs nothing but
 * honesty, and is what stops one property's conflicting numbers from attaching to a question about a
 * different property.
 */
export function scopeConflictToQuestion(
  questionText: string,
  groups: readonly ConflictedFactGroup[],
  canonicalEntities: readonly CanonicalEntityListing[],
): ConflictedFactGroup | null {
  const entity = resolveQuestionEntity(questionText, canonicalEntities);
  if (!entity) {
    return null;
  }

  const scopedGroups = filterGroupsByEntity(groups, entity);
  return scopedGroups.length === 1 ? scopedGroups[0] : null;
}
