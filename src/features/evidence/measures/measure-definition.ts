import { Types } from 'mongoose';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../database/schemas/evidence/document/document.schema';
import type {
  Measure,
  MeasureOrigin,
  MeasureStatus,
  MeasureUnit,
} from '../../../database/schemas/evidence/measure/measure.schema';
import { METRIC_IDS, type MetricDefinition, type MetricId } from '../facts/metric-ontology';
import { InvalidMeasureDefinitionException } from './exceptions/measures.exception';

/**
 * A `Measure` row projected into the shape every consumer already matches against
 * (`findMetricByAlias`/`findMetricById`, `metric-ontology.ts`) — `id` is the measure's `slug`, the
 * join key `ExtractedFact.factKey.metric` carries, never `measureId`. The four fields this type
 * adds beyond `MetricDefinition` are provenance the ontology constant never needed: which row
 * produced this definition, at what version, and whether a human has confirmed it yet.
 */
export interface MeasureDefinition extends MetricDefinition {
  readonly measureId: string;
  readonly version: number;
  readonly status: MeasureStatus;
  readonly origin: MeasureOrigin;
}

/** The measure provenance a fact stamps at extraction time — never re-derived from the
 * measure's *current* definition, so a fact keeps saying which version it was extracted under
 * even after that measure has since been edited. */
export interface MeasureStamp {
  readonly measureId: Types.ObjectId;
  readonly measureVersion: number;
  readonly measureStatus: 'proposed' | 'confirmed';
}

type MeasureDefinitionSource = Pick<
  Measure,
  | '_id'
  | 'slug'
  | 'label'
  | 'aliases'
  | 'valueType'
  | 'canonicalUnit'
  | 'units'
  | 'toleranceKind'
  | 'tolerance'
  | 'authorityOrder'
  | 'stalenessWindowMs'
  | 'status'
  | 'origin'
  | 'version'
>;

/** Projects one `Measure` row into a `MeasureDefinition` — `id = slug`, `measureId = _id`,
 * `authorityOrder`/`stalenessWindowMs` carried over only when the row itself has one (never
 * defaulted to an empty array or omitted key, matching `Measure`'s own `default: undefined`). */
export function toMeasureDefinition(doc: MeasureDefinitionSource): MeasureDefinition {
  return {
    id: doc.slug,
    label: doc.label,
    aliases: doc.aliases,
    valueType: doc.valueType,
    canonicalUnit: doc.canonicalUnit,
    units: doc.units,
    toleranceKind: doc.toleranceKind,
    tolerance: doc.tolerance,
    ...(doc.authorityOrder ? { authorityOrder: doc.authorityOrder } : {}),
    ...(doc.stalenessWindowMs !== undefined ? { stalenessWindowMs: doc.stalenessWindowMs } : {}),
    measureId: doc._id.toString(),
    version: doc.version,
    status: doc.status,
    origin: doc.origin,
  };
}

export function toMeasureDefinitions(
  docs: readonly MeasureDefinitionSource[],
): MeasureDefinition[] {
  return docs.map(toMeasureDefinition);
}

/**
 * Orders a tenant's measure definitions the way the prose extractor's system prompt and
 * structured-output enum are built: every `'seed'`-origin row first, in `METRIC_ONTOLOGY`'s own
 * order, then every other row by `id` ascending. For a seed-only tenant this reproduces
 * `METRIC_ONTOLOGY`'s order exactly, byte-for-byte — the invariant `measure-definition.spec.ts`
 * pins and the eval replay cache's system-prompt hash depends on. `Array.prototype.sort` is
 * stable, so a header-origin row never displaces another header-origin row that sorts equal to it.
 */
export function orderForExtraction<T extends MeasureDefinition>(defs: readonly T[]): T[] {
  const seedRows = defs.filter((def) => def.origin === 'seed');
  const otherRows = defs.filter((def) => def.origin !== 'seed');
  const orderedSeedRows = [...seedRows].sort(
    (a, b) => METRIC_IDS.indexOf(a.id as MetricId) - METRIC_IDS.indexOf(b.id as MetricId),
  );
  const orderedOtherRows = [...otherRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...orderedSeedRows, ...orderedOtherRows];
}

const UNIT_ID_GRAMMAR = /^[a-z][a-z0-9_]{0,63}$/;

/** `'unclassified'` is excluded: an unclassified document has no claim to authority over any
 * other source (`MetricDefinition.authorityOrder`'s own doc comment). */
const AUTHORITY_SOURCE_CLASSES = new Set<DocumentSourceClass>(
  DOCUMENT_SOURCE_CLASSES.filter((sourceClass) => sourceClass !== 'unclassified'),
);

interface MeasureDefinitionInput {
  readonly label: string;
  readonly aliases: readonly string[];
  readonly canonicalUnit: string;
  readonly units: readonly MeasureUnit[];
  readonly tolerance: number;
  readonly authorityOrder?: readonly DocumentSourceClass[];
  readonly stalenessWindowMs?: number;
}

/**
 * Validates a measure definition against the rules `MeasuresService.confirm`/`update` must never
 * persist a violation of, throwing {@link InvalidMeasureDefinitionException} on the first rule
 * broken. Fails CLOSED: any violation refuses the whole write rather than persisting a
 * partially-valid definition.
 */
export function validateMeasureDefinition(def: MeasureDefinitionInput): void {
  if (def.units.length < 1) {
    throw new InvalidMeasureDefinitionException('units must include at least one unit');
  }

  const unitIds = def.units.map((unit) => unit.id);
  if (new Set(unitIds).size !== unitIds.length) {
    throw new InvalidMeasureDefinitionException('units must have unique ids');
  }

  for (const unit of def.units) {
    if (!UNIT_ID_GRAMMAR.test(unit.id)) {
      throw new InvalidMeasureDefinitionException(
        `unit id '${unit.id}' must match ${UNIT_ID_GRAMMAR.source}`,
      );
    }
    if (!Number.isFinite(unit.toCanonicalFactor) || unit.toCanonicalFactor <= 0) {
      throw new InvalidMeasureDefinitionException(
        `unit '${unit.id}' toCanonicalFactor must be finite and greater than 0`,
      );
    }
  }

  const canonicalUnits = def.units.filter((unit) => unit.toCanonicalFactor === 1);
  if (canonicalUnits.length !== 1 || canonicalUnits[0].id !== def.canonicalUnit) {
    throw new InvalidMeasureDefinitionException(
      `exactly one unit must have toCanonicalFactor 1 and its id must equal canonicalUnit '${def.canonicalUnit}'`,
    );
  }

  if (!Number.isFinite(def.tolerance) || def.tolerance < 0) {
    throw new InvalidMeasureDefinitionException('tolerance must be finite and at least 0');
  }

  if (def.label.length < 1 || def.label.length > 200) {
    throw new InvalidMeasureDefinitionException('label must be between 1 and 200 characters');
  }

  const seenAliases = new Set<string>();
  for (const alias of def.aliases) {
    if (alias.length < 1 || alias.length > 200) {
      throw new InvalidMeasureDefinitionException(
        `alias '${alias}' must be between 1 and 200 characters`,
      );
    }
    const normalized = alias.trim().toLowerCase();
    if (seenAliases.has(normalized)) {
      throw new InvalidMeasureDefinitionException(`alias '${alias}' duplicates another alias`);
    }
    seenAliases.add(normalized);
  }

  if (def.authorityOrder) {
    const seenClasses = new Set<DocumentSourceClass>();
    for (const sourceClass of def.authorityOrder) {
      if (!AUTHORITY_SOURCE_CLASSES.has(sourceClass)) {
        throw new InvalidMeasureDefinitionException(
          `authorityOrder entry '${sourceClass}' must be a classified document source`,
        );
      }
      if (seenClasses.has(sourceClass)) {
        throw new InvalidMeasureDefinitionException(
          `authorityOrder duplicates source class '${sourceClass}'`,
        );
      }
      seenClasses.add(sourceClass);
    }
  }

  if (
    def.stalenessWindowMs !== undefined &&
    (!Number.isInteger(def.stalenessWindowMs) || def.stalenessWindowMs < 0)
  ) {
    throw new InvalidMeasureDefinitionException('stalenessWindowMs must be a non-negative integer');
  }
}
