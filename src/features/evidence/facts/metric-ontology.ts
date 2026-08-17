import type { DocumentSourceClass } from '../../../database/schemas/evidence/document/document.schema';

/**
 * The allowlist of valuation metrics fact extraction is permitted to produce. An open-ended
 * extractor would invent its own metric names per document ("cap rate" vs "capitalization rate"
 * vs "going-in yield"), and nothing downstream could ever compare two documents' figures again —
 * conflict detection groups facts by exact metric id, so the id space has to be closed.
 *
 * Both extractors (`xlsx-fact-extractor.ts`, `prose-fact-extractor.ts`) only ever emit a `metric`
 * value from `METRIC_IDS`: the xlsx extractor by matching a column header against `aliases`, the
 * model extractor because its structured-output schema (`contracts/fact-extraction.contract.ts`)
 * constrains the field to `z.enum(METRIC_IDS)`.
 */
export const METRIC_IDS = [
  'cap_rate',
  'sale_price',
  'price_per_sf',
  'building_area_sf',
  'net_operating_income',
  'base_rent_psf',
  'lease_term_years',
  'tenant_occupancy_share',
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

export type FactValueType = 'currency' | 'percentage' | 'area' | 'duration';

export type ToleranceKind = 'absolute' | 'relative';

/** Multiplicative conversion from a unit form a document might report to the metric's
 * `canonicalUnit`. Every unit in this ontology is a pure scale factor — nothing here needs an
 * offset (unlike, say, a temperature conversion), so a single number is enough. */
export interface MetricUnitDefinition {
  readonly id: string;
  readonly toCanonicalFactor: number;
}

export interface MetricDefinition {
  readonly id: MetricId;
  readonly label: string;
  /** Exact header/phrase forms a document might use, matched case-insensitively. Includes the
   * canonical label itself so callers can search one list. */
  readonly aliases: readonly string[];
  readonly valueType: FactValueType;
  readonly canonicalUnit: string;
  readonly units: readonly MetricUnitDefinition[];
  readonly toleranceKind: ToleranceKind;
  /**
   * `absolute`: two normalized values conflict when their difference in `canonicalUnit` exceeds
   * this number outright — used for percentage-like metrics, where the values themselves are
   * already small and a relative threshold would behave oddly near zero.
   * `relative`: they conflict when the difference exceeds this fraction of the larger magnitude —
   * used for currency/area metrics, where absolute dollar or square-foot gaps scale with the
   * asset's size and a fixed absolute threshold would either flag every large deal or miss every
   * small one.
   */
  readonly tolerance: number;
  /**
   * Most-authoritative-first ranking of source classes for this metric. When two facts about the
   * same `FactKey` disagree, a survivorship policy prefers the value from whichever conflicting
   * fact's document has the highest-ranked `sourceClass` here. Optional, and left absent by
   * default: a metric with no configured order gives the policy nothing to rank by, so it must
   * produce no preferred value for that metric rather than a guessed one. Never includes
   * `'unclassified'` — an unclassified document has no claim to authority over any other source.
   */
  readonly authorityOrder?: readonly DocumentSourceClass[];
  /**
   * How long an observed value stays current for this metric, in milliseconds, measured from
   * `ExtractedFact.observedAt`. Optional: a metric with no configured window has no staleness
   * check applied to it — appropriate for a metric whose value is a fixed historical fact (e.g. a
   * closed sale price) rather than one that drifts with the market or with property operations.
   */
  readonly stalenessWindowMs?: number;
}

export const METRIC_ONTOLOGY: readonly MetricDefinition[] = [
  {
    id: 'cap_rate',
    label: 'Cap Rate',
    aliases: ['Cap Rate', 'cap rate', 'capitalization rate', 'going-in cap rate', 'going-in rate'],
    valueType: 'percentage',
    canonicalUnit: 'ratio',
    units: [
      { id: 'ratio', toCanonicalFactor: 1 },
      { id: 'percent', toCanonicalFactor: 0.01 },
    ],
    toleranceKind: 'absolute',
    // 25 basis points — tight enough that the seeded 85bp Northgate conflict (5.25% vs 6.10%)
    // clears it many times over, loose enough to absorb a document rounding to the nearest 5bp.
    tolerance: 0.0025,
    // 180 days — market cap rates move with lending conditions; an observation older than about
    // two quarters no longer reflects current pricing.
    stalenessWindowMs: 180 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'sale_price',
    label: 'Sale Price',
    aliases: ['Sale Price (USD)', 'sale price', 'purchase price', 'contract price'],
    valueType: 'currency',
    canonicalUnit: 'usd',
    units: [
      { id: 'usd', toCanonicalFactor: 1 },
      { id: 'usd_thousands', toCanonicalFactor: 1_000 },
      { id: 'usd_millions', toCanonicalFactor: 1_000_000 },
    ],
    toleranceKind: 'relative',
    // 1% absorbs prose rounding ("$41.0 million" for $41,000,000) without absorbing a genuinely
    // different reported price.
    tolerance: 0.01,
    // Deliberately unconfigured: a closed sale price is a negotiated transaction term, and none of
    // this ontology's source classes is the transaction's own record — a CRM tracks the deal as a
    // broker saw it, a spreadsheet compiles it secondhand, a memo narrates it. No staleness window
    // either — a historical sale price does not change after the fact.
  },
  {
    id: 'price_per_sf',
    label: 'Price per SF',
    aliases: ['Price per SF (USD)', 'price per square foot', 'price per sf', '$/sf', '$/SF'],
    valueType: 'currency',
    canonicalUnit: 'usd_per_sf',
    units: [{ id: 'usd_per_sf', toCanonicalFactor: 1 }],
    toleranceKind: 'relative',
    tolerance: 0.01,
    // Deliberately unconfigured: a per-square-foot price is derived from sale_price and
    // building_area_sf, so it inherits whichever source reported those two figures rather than
    // carrying an authority ranking of its own.
  },
  {
    id: 'building_area_sf',
    label: 'Building Area',
    aliases: [
      'Building Area (SF)',
      'building area',
      'square footage',
      'rentable square feet',
      'net rentable area',
    ],
    valueType: 'area',
    canonicalUnit: 'sf',
    units: [
      { id: 'sf', toCanonicalFactor: 1 },
      { id: 'thousand_sf', toCanonicalFactor: 1_000 },
    ],
    toleranceKind: 'relative',
    tolerance: 0.01,
    // A property-management export carries building area as an operational rent-roll figure; a
    // comps spreadsheet is a structured secondhand compilation of that same figure; a CRM deal
    // export cites area from marketing/offering materials, the least independently verified of
    // the three. No staleness window — a building's square footage is a physical fact that does
    // not decay with time the way a market rate does.
    authorityOrder: ['pm-export', 'spreadsheet', 'crm-export'],
  },
  {
    id: 'net_operating_income',
    label: 'Net Operating Income',
    aliases: ['Net Operating Income (USD)', 'net operating income', 'noi'],
    valueType: 'currency',
    canonicalUnit: 'usd',
    units: [
      { id: 'usd', toCanonicalFactor: 1 },
      { id: 'usd_thousands', toCanonicalFactor: 1_000 },
      { id: 'usd_millions', toCanonicalFactor: 1_000_000 },
    ],
    toleranceKind: 'relative',
    tolerance: 0.01,
    // A property-management export reports NOI as the operational actual (income less expenses
    // from the records it administers); a comps spreadsheet's NOI is normally an underwriting
    // figure recomputed one step removed from that operational source.
    authorityOrder: ['pm-export', 'spreadsheet'],
    // 365 days — NOI is customarily reported on a trailing-twelve-month basis, so a figure inside
    // one operating year is still the current trailing figure.
    stalenessWindowMs: 365 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'base_rent_psf',
    label: 'Base Rent per SF',
    aliases: ['base rent', 'base rent per square foot', 'rent per square foot'],
    valueType: 'currency',
    canonicalUnit: 'usd_per_sf_per_year',
    units: [{ id: 'usd_per_sf_per_year', toCanonicalFactor: 1 }],
    toleranceKind: 'relative',
    tolerance: 0.01,
    // Deliberately unconfigured: market asking/base rent is quoted by whoever is marketing the
    // space (broker, landlord, memo author) with no single source class more reliably the rent's
    // own record than another.
    // 180 days — asking rents move with the leasing market; treat an observation older than about
    // two quarters as no longer reflecting current asking rates.
    stalenessWindowMs: 180 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'lease_term_years',
    label: 'Lease Term',
    aliases: ['lease term', 'initial term', 'term'],
    valueType: 'duration',
    canonicalUnit: 'years',
    units: [
      { id: 'years', toCanonicalFactor: 1 },
      { id: 'months', toCanonicalFactor: 1 / 12 },
    ],
    toleranceKind: 'absolute',
    // A lease term is a negotiated integer, not a measurement with rounding error — any
    // disagreement at all is a real conflict, so the tolerance is zero rather than merely small.
    tolerance: 0,
    // Deliberately unconfigured: a signed lease term is fixed once executed, so it neither has a
    // source-class authority a practitioner would agree on (a CRM tracks the deal as negotiated, a
    // PM export tracks it as administered — genuinely disputable which is "more true") nor a
    // staleness window (the term does not change after signing).
  },
  {
    id: 'tenant_occupancy_share',
    label: 'Tenant Occupancy Share',
    aliases: [
      'occupancy',
      'percent leased',
      'net rentable area occupied',
      'tenant share',
      'occupied share',
    ],
    valueType: 'percentage',
    canonicalUnit: 'ratio',
    units: [
      { id: 'ratio', toCanonicalFactor: 1 },
      { id: 'percent', toCanonicalFactor: 0.01 },
    ],
    toleranceKind: 'absolute',
    // One percentage point.
    tolerance: 0.01,
    // Occupancy is tracked in a property-management system's rent roll as the actual leased-versus
    // -vacant state; a comps spreadsheet's occupancy figure is a compiled snapshot of that same
    // rent roll, one step removed.
    authorityOrder: ['pm-export', 'spreadsheet'],
    // 90 days — a rent roll is normally reconciled at least quarterly, and tenants move in and out
    // in between; an observation older than a quarter no longer reflects who is actually in the
    // building.
    stalenessWindowMs: 90 * 24 * 60 * 60 * 1000,
  },
];

function normalizeAlias(text: string): string {
  return text.trim().toLowerCase();
}

/** Case-insensitive match against a metric's label and aliases — how the deterministic xlsx
 * extractor maps a column header to a metric, and how a system prompt is built to explain the
 * allowlist to the model. */
export function findMetricByAlias(
  ontology: readonly MetricDefinition[],
  headerOrPhrase: string,
): MetricDefinition | undefined {
  const needle = normalizeAlias(headerOrPhrase);
  return ontology.find(
    (metric) =>
      normalizeAlias(metric.label) === needle ||
      metric.aliases.some((alias) => normalizeAlias(alias) === needle),
  );
}

export function findMetricById(
  ontology: readonly MetricDefinition[],
  id: string,
): MetricDefinition | undefined {
  return ontology.find((metric) => metric.id === id);
}
