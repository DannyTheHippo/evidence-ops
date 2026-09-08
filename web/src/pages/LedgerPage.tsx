import { useEffect, useState } from 'react';
import {
  listLedgerCells,
  listMeasures,
  type LedgerCell,
  type LedgerCellState,
} from '../api/client';
import { IconDatabase } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge, { type BadgeTone } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import FilterBar from '../components/ui/FilterBar';
import Input from '../components/ui/Input';
import Pager from '../components/ui/Pager';
import Panel from '../components/ui/Panel';
import Select from '../components/ui/Select';
import Table, { TableCell, TableHeaderCell, TableRow } from '../components/ui/Table';
import { useUrlState } from '../lib/use-url-state';
import LedgerCellDetail from './ledger/LedgerCellDetail';

const PAGE_SIZE = 25;

// Declared at module scope, matching every other list page's `URL_DEFAULTS` — `useUrlState`
// adopts this once on mount and keeps that identity for the hook's lifetime.
const URL_DEFAULTS: Record<
  'entity' | 'measure' | 'state' | 'period' | 'skip' | 'selected',
  string
> = {
  entity: '',
  measure: '',
  state: '',
  period: '',
  skip: '0',
  selected: '',
};

const STATE_OPTIONS: { value: LedgerCellState | ''; label: string }[] = [
  { value: '', label: 'All states' },
  { value: 'single', label: 'single' },
  { value: 'adjudicated', label: 'adjudicated' },
  { value: 'conflicted', label: 'conflicted' },
  { value: 'unknown', label: 'unknown' },
];

const STATE_TONE: Record<LedgerCellState, BadgeTone> = {
  single: 'verified',
  adjudicated: 'info',
  conflicted: 'caution',
  unknown: 'neutral',
};

// A cell has no id of its own — entity, measure and period together are its identity, the same
// composite key `listLedgerFacts` addresses a cell's facts by.
function cellKey(cell: LedgerCell): string {
  return [cell.entity, cell.measure, cell.period ?? ''].join('\t');
}

export default function LedgerPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedEntity = urlState.entity;
  const appliedMeasure = urlState.measure;
  const appliedState = urlState.state as LedgerCellState | '';
  const appliedPeriod = urlState.period;
  const skip = Number(urlState.skip);
  const selected = urlState.selected;

  // Only these, not the filter controls' own values, drive the fetch — the filter applies on
  // submit, not on every keystroke.
  const [draftEntity, setDraftEntity] = useState(appliedEntity);
  const [draftMeasure, setDraftMeasure] = useState(appliedMeasure);
  const [draftState, setDraftState] = useState(appliedState);
  const [draftPeriod, setDraftPeriod] = useState(appliedPeriod);

  const [cells, setCells] = useState<LedgerCell[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [measureLabels, setMeasureLabels] = useState<Record<string, string>>({});
  const [measureOptions, setMeasureOptions] = useState<{ value: string; label: string }[]>([]);

  // The confirmed-measure vocabulary for the filter's Select and every row's Measure column —
  // fetched once, independent of the cell filters. A failed fetch leaves both empty rather than
  // blocking the page: a slug renders in place of a label, and the filter offers only "All
  // measures". 100 is the server's max page size (A11) — a tenant confirming more than 100
  // measures sees a truncated filter, a recorded bound rather than a paged fetch here.
  useEffect(() => {
    listMeasures({ status: 'confirmed', limit: 100 })
      .then(({ docs }) => {
        setMeasureLabels(Object.fromEntries(docs.map((measure) => [measure.slug, measure.label])));
        setMeasureOptions(docs.map((measure) => ({ value: measure.slug, label: measure.label })));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    listLedgerCells({
      skip,
      limit: PAGE_SIZE,
      entity: appliedEntity || undefined,
      measure: appliedMeasure || undefined,
      state: appliedState || undefined,
      period: appliedPeriod || undefined,
    })
      .then(({ docs, count: total }) => {
        if (cancelled) return;
        setCells(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load ledger cells');
      });

    return () => {
      cancelled = true;
    };
  }, [skip, appliedEntity, appliedMeasure, appliedState, appliedPeriod]);

  function handleApplyFilter() {
    setUrlState({
      entity: draftEntity,
      measure: draftMeasure,
      state: draftState,
      period: draftPeriod,
      skip: URL_DEFAULTS.skip,
    });
  }

  function handleClearFilter() {
    setDraftEntity(URL_DEFAULTS.entity);
    setDraftMeasure(URL_DEFAULTS.measure);
    setDraftState(URL_DEFAULTS.state as LedgerCellState | '');
    setDraftPeriod(URL_DEFAULTS.period);
    setUrlState({
      entity: URL_DEFAULTS.entity,
      measure: URL_DEFAULTS.measure,
      state: URL_DEFAULTS.state,
      period: URL_DEFAULTS.period,
      skip: URL_DEFAULTS.skip,
    });
  }

  const hasFilter =
    appliedEntity !== URL_DEFAULTS.entity ||
    appliedMeasure !== URL_DEFAULTS.measure ||
    appliedState !== URL_DEFAULTS.state ||
    appliedPeriod !== URL_DEFAULTS.period;

  const selectedCell = cells?.find((cell) => cellKey(cell) === selected) ?? null;

  let status: RecordListStatus;
  if (cells === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading ledger cells…' };
  } else if (cells.length === 0) {
    status = hasFilter
      ? {
          kind: 'empty',
          icon: <IconDatabase size={24} />,
          title: 'No cells match these filters',
          action: (
            <Button variant="secondary" onClick={handleClearFilter}>
              Clear filters
            </Button>
          ),
        }
      : {
          kind: 'empty',
          icon: <IconDatabase size={24} />,
          title: 'No ledger cells yet',
          description: 'Cells appear as facts are extracted and measures are confirmed.',
        };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Ledger"
      title="Ledger"
      description="What the estate's documents say per entity, measure and period — and whether the record agrees with itself."
      filters={
        <FilterBar onApply={handleApplyFilter} onClear={handleClearFilter} hasFilter={hasFilter}>
          <Input label="Entity" value={draftEntity} onChange={setDraftEntity} />
          <Select
            label="Measure"
            options={[{ value: '', label: 'All measures' }, ...measureOptions]}
            value={draftMeasure}
            onChange={setDraftMeasure}
          />
          <Select
            label="State"
            options={STATE_OPTIONS}
            value={draftState}
            onChange={(value) => setDraftState(value as LedgerCellState | '')}
          />
          <Input label="Period" hint="e.g. 2025-Q1" value={draftPeriod} onChange={setDraftPeriod} />
        </FilterBar>
      }
      toolbarEnd={
        cells && (
          <span className="mono cell-sub">
            {count} cell{count === 1 ? '' : 's'}
          </span>
        )
      }
      error={error ?? undefined}
      status={status}
      skeletonVariant="table"
      footer={
        cells && (
          <Pager
            count={count}
            skip={skip}
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
          />
        )
      }
    >
      {cells && cells.length > 0 && (
        <Panel aria-label="Ledger cells">
          <Table caption="Entity, measure and period cells with their resolved state">
            <thead>
              <tr>
                <TableHeaderCell>Entity</TableHeaderCell>
                <TableHeaderCell>Measure</TableHeaderCell>
                <TableHeaderCell>Period</TableHeaderCell>
                <TableHeaderCell>Value</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Facts</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {cells.map((cell) => (
                <TableRow key={cellKey(cell)} selected={cellKey(cell) === selected}>
                  <TableCell label="Entity">{cell.entity}</TableCell>
                  <TableCell label="Measure">
                    {measureLabels[cell.measure] ?? cell.measure}
                  </TableCell>
                  {/* The server's period sentinel for "the facts carried no period" — shown as a
                      dash rather than the raw string, matching every other absent-value cell. */}
                  <TableCell label="Period">
                    {cell.period === 'undated' ? '—' : cell.period}
                  </TableCell>
                  <TableCell label="Value">
                    {cell.value ? (
                      <span className="mono" title={String(cell.value.canonicalAmount)}>
                        {cell.value.amount} {cell.value.unit}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell label="State">
                    <Badge tone={STATE_TONE[cell.state]}>{cell.state}</Badge>
                  </TableCell>
                  <TableCell label="Facts" className="cell-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setUrlState({ selected: cellKey(cell) })}
                    >
                      View facts
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}

      {selectedCell && (
        <LedgerCellDetail
          cell={selectedCell}
          measureLabel={measureLabels[selectedCell.measure] ?? selectedCell.measure}
        />
      )}
    </RecordListPage>
  );
}
