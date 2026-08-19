import { useEffect, useState } from 'react';
import {
  getResolutionBacktest,
  listMetricPolicies,
  type BacktestVerdict,
  type MetricId,
  type MetricPolicy,
  type ResolutionBacktest,
} from '../api/client';
import { IconAlertTriangle } from '../components/icons';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';
import RuleEditorDialog from './resolution-rules/RuleEditorDialog';

// The full ontology — mirrors METRIC_IDS (metric-ontology.ts) so the table always shows every
// metric an operator can author a rule for, not only the ones with an existing row.
const METRIC_IDS: MetricId[] = [
  'cap_rate',
  'sale_price',
  'price_per_sf',
  'building_area_sf',
  'net_operating_income',
  'base_rent_psf',
  'lease_term_years',
  'tenant_occupancy_share',
];

// A rule contradicting a human decision is verification-grade, not neutral — 'disagreed' reads as
// 'rejected'. 'silent' means the policy genuinely returned no opinion, which is a fact about the
// rule, not a failure.
const VERDICT_TONE: Record<BacktestVerdict, 'verified' | 'rejected' | 'neutral' | 'info'> = {
  agreed: 'verified',
  disagreed: 'rejected',
  silent: 'neutral',
  unscorable: 'info',
};

function verdictDetail(result: ResolutionBacktest['results'][number]): string {
  if (result.verdict === 'unscorable') {
    return result.unscorableReason ?? 'Cannot be judged.';
  }
  if (result.verdict === 'silent') {
    return 'The policy fired no opinion for this conflict.';
  }
  return `Recorded ${result.recordedOutcome}; the replayed rule fired ${result.replayedRuleFired}.`;
}

export default function ResolutionRulesPage() {
  const [policies, setPolicies] = useState<MetricPolicy[] | null>(null);
  const [policiesError, setPoliciesError] = useState<string | null>(null);
  const [backtest, setBacktest] = useState<ResolutionBacktest | null>(null);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [editingMetric, setEditingMetric] = useState<MetricId | null>(null);

  useEffect(() => {
    listMetricPolicies()
      .then(({ docs }) => {
        setPolicies(docs);
        setPoliciesError(null);
      })
      .catch((err: unknown) => {
        setPoliciesError(err instanceof Error ? err.message : 'Failed to load resolution rules');
      });
  }, []);

  useEffect(() => {
    getResolutionBacktest()
      .then((result) => {
        setBacktest(result);
        setBacktestError(null);
      })
      .catch((err: unknown) => {
        setBacktestError(err instanceof Error ? err.message : 'Failed to load hindsight check');
      });
  }, []);

  const editingPolicy = policies?.find((policy) => policy.metric === editingMetric);

  function handleSaved(updated: MetricPolicy) {
    setPolicies((current) => {
      const rest = (current ?? []).filter((row) => row.metric !== updated.metric);
      return [...rest, updated].sort((a, b) => a.metric.localeCompare(b.metric));
    });
    setEditingMetric(null);
  }

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Admin</span>
          <h1 className="page-title">Resolution Rules</h1>
          <p className="page-sub">
            The survivorship order this tenant has authored for each metric, and how those rules
            have held up against every conflict a human has already resolved.
          </p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Authority order</h2>
        </div>
        {policiesError && (
          <p className="error error--page" role="alert">
            {policiesError}
          </p>
        )}
        {!policies && !policiesError && <Skeleton label="Loading resolution rules…" />}
        {policies && (
          <section className="panel">
            <Table caption="Each metric's authored authority order, most-authoritative source class first.">
              <thead>
                <tr>
                  <TableHeaderCell>Metric</TableHeaderCell>
                  <TableHeaderCell>Authority order</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </tr>
              </thead>
              <tbody>
                {METRIC_IDS.map((metric) => {
                  const policy = policies.find((row) => row.metric === metric);
                  const order = policy?.authorityOrder;
                  return (
                    <tr key={metric}>
                      <td>{metric}</td>
                      <td className="cell-sub">
                        {order && order.length > 0 ? order.join(' › ') : 'No order configured'}
                      </td>
                      <td className="cell-actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setEditingMetric(metric)}
                        >
                          Edit
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </section>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Hindsight check</h2>
        </div>
        {backtestError && (
          <p className="error error--page" role="alert">
            {backtestError}
          </p>
        )}
        {!backtest && !backtestError && <Skeleton label="Loading hindsight check…" />}
        {backtest && backtest.results.length === 0 && (
          <EmptyState
            icon={<IconAlertTriangle size={24} />}
            title="Nothing to backtest yet"
            description="No conflict in this tenant has ever reached a resolution attempt."
          />
        )}
        {backtest && backtest.results.length > 0 && (
          <>
            <p className="card-meta">
              {backtest.agreed} agreed · {backtest.disagreed} disagreed · {backtest.silent} silent ·{' '}
              {backtest.unscorable} unscorable ·{' '}
              {backtest.agreementRate === null
                ? 'No scorable conflicts yet'
                : `${Math.round(backtest.agreementRate * 100)}% agreement`}
            </p>
            <section className="panel">
              <Table caption="Every conflict with a resolution attempt, replayed against the tenant's current survivorship rules.">
                <thead>
                  <tr>
                    <TableHeaderCell>Entity</TableHeaderCell>
                    <TableHeaderCell>Metric</TableHeaderCell>
                    <TableHeaderCell>Period</TableHeaderCell>
                    <TableHeaderCell>Verdict</TableHeaderCell>
                    <TableHeaderCell>Detail</TableHeaderCell>
                  </tr>
                </thead>
                <tbody>
                  {backtest.results.map((result) => (
                    <tr key={result.conflictId}>
                      <td>{result.factKey.entity}</td>
                      <td className="cell-sub">{result.factKey.metric}</td>
                      <td className="cell-sub">{result.factKey.period}</td>
                      <td>
                        <Badge tone={VERDICT_TONE[result.verdict]}>{result.verdict}</Badge>
                      </td>
                      <td className="cell-sub">{verdictDetail(result)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>
          </>
        )}
      </section>

      {editingMetric && (
        <RuleEditorDialog
          metric={editingMetric}
          authorityOrder={editingPolicy?.authorityOrder}
          stalenessWindowMs={editingPolicy?.stalenessWindowMs}
          onClose={() => setEditingMetric(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
