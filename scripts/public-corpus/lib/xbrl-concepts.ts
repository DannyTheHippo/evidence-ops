import { MEASURE_SLUGS } from './measure-slugs';

/**
 * A candidate `us-gaap` (or `dei`) concept the numeric-case author reads from a registrant's
 * companyfacts JSON (`facts[taxonomy][name].units[unit][]`, plan Assumptions 4). `measureSlug`
 * ties the concept to the `eval-public` tenant measure it feeds (`measure-slugs.ts`, `measures.json`
 * in 5.4), so a fact minted from this concept always lands under a measure the tenant has confirmed.
 */
export interface XbrlConcept {
  readonly taxonomy: 'us-gaap' | 'dei';
  readonly name: string;
  readonly label: string;
  readonly measureSlug: (typeof MEASURE_SLUGS)[number];
  readonly valueType: 'currency' | 'count' | 'area' | 'per-share';
  readonly unit: string;
}

// One entry per MEASURE_SLUGS index — the two lists are kept in lockstep by construction, and
// `select-xbrl-facts.spec.ts` pins that every slug is covered.
export const XBRL_CONCEPTS: readonly XbrlConcept[] = [
  {
    taxonomy: 'us-gaap',
    name: 'Revenues',
    label: 'Total revenues',
    measureSlug: 'total_revenues',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'OperatingLeaseLeaseIncome',
    label: 'Rental revenue',
    measureSlug: 'rental_revenue',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'NetIncomeLoss',
    label: 'Net income',
    measureSlug: 'net_income',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'Assets',
    label: 'Total assets',
    measureSlug: 'total_assets',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'Liabilities',
    label: 'Total liabilities',
    measureSlug: 'total_liabilities',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'StockholdersEquity',
    label: "Total stockholders' equity",
    measureSlug: 'stockholders_equity',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'LongTermDebt',
    label: 'Total debt',
    measureSlug: 'total_debt',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'InterestExpense',
    label: 'Interest expense',
    measureSlug: 'interest_expense',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'DepreciationDepletionAndAmortization',
    label: 'Depreciation and amortization',
    measureSlug: 'depreciation_amortization',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'RealEstateInvestmentPropertyNet',
    label: 'Real estate investments, net',
    measureSlug: 'real_estate_net',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'RealEstateInvestmentPropertyAtCost',
    label: 'Real estate investments, at cost',
    measureSlug: 'real_estate_gross',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'CashAndCashEquivalentsAtCarryingValue',
    label: 'Cash and cash equivalents',
    measureSlug: 'cash_and_equivalents',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'NetCashProvidedByUsedInOperatingActivities',
    label: 'Net cash provided by operating activities',
    measureSlug: 'operating_cash_flow',
    valueType: 'currency',
    unit: 'USD',
  },
  {
    taxonomy: 'us-gaap',
    name: 'CommonStockDividendsPerShareDeclared',
    label: 'Dividends declared per share',
    measureSlug: 'dividends_per_share',
    valueType: 'per-share',
    unit: 'USD/shares',
  },
  {
    taxonomy: 'us-gaap',
    name: 'EarningsPerShareDiluted',
    label: 'Diluted earnings per share',
    measureSlug: 'eps_diluted',
    valueType: 'per-share',
    unit: 'USD/shares',
  },
  {
    taxonomy: 'us-gaap',
    name: 'WeightedAverageNumberOfDilutedSharesOutstanding',
    label: 'Diluted weighted average shares outstanding',
    measureSlug: 'diluted_shares',
    valueType: 'count',
    unit: 'shares',
  },
  {
    taxonomy: 'us-gaap',
    name: 'NumberOfRealEstateProperties',
    label: 'Number of real estate properties',
    measureSlug: 'property_count',
    valueType: 'count',
    unit: 'pure',
  },
  {
    taxonomy: 'us-gaap',
    name: 'AreaOfRealEstateProperty',
    label: 'Total rentable square feet',
    measureSlug: 'rentable_area',
    valueType: 'area',
    unit: 'sqft',
  },
];

const LABEL_STOPWORDS = new Set(['and', 'the', 'of', 'in', 'at', 'per', 'a', 'to', 'for']);

/**
 * Lowercase, non-stopword words from a concept's `label`, for `locateValue`'s row-label match. A
 * single shared word (e.g. "assets") is deliberately enough — the row-label check exists to rule
 * out an unlabelled bare value, not to require an exact label match against filer-specific phrasing.
 */
export function labelTokens(concept: XbrlConcept): readonly string[] {
  return concept.label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !LABEL_STOPWORDS.has(word));
}
