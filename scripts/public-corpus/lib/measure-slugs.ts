/**
 * The eighteen REIT measure slugs confirmed for the `eval-public` tenant. The one list
 * `eval/public/measures.json` (5.4) and `xbrl-concepts.ts` (5.10) both key off of, so a slug
 * cannot exist on one side without the other.
 */
export const MEASURE_SLUGS = [
  'total_revenues',
  'rental_revenue',
  'net_income',
  'total_assets',
  'total_liabilities',
  'stockholders_equity',
  'total_debt',
  'interest_expense',
  'depreciation_amortization',
  'real_estate_net',
  'real_estate_gross',
  'cash_and_equivalents',
  'operating_cash_flow',
  'dividends_per_share',
  'eps_diluted',
  'diluted_shares',
  'property_count',
  'rentable_area',
] as const;
