import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import {
  listLedgerCells,
  listMeasures,
  type LedgerCell,
  type LedgerCellSortField,
  type LedgerCellState,
  type SortDirection,
} from '../api/client';
import { IconDatabase } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge, { type BadgeTone } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Drawer from '../components/ui/Drawer';
import FilterBar from '../components/ui/FilterBar';
import Input from '../components/ui/Input';
import Pager from '../components/ui/Pager';
import Panel from '../components/ui/Panel';
import Select from '../components/ui/Select';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell, TableRow } from '../components/ui/Table';
import Tooltip from '../components/ui/Tooltip';
import { formatCanonicalValue, formatMeasureValue } from '../lib/format-value';
import { clampPageSize, clampSkip, pickOption } from '../lib/paging';
import { useDebouncedApply } from '../lib/use-debounced-apply';
import { useResultAnnouncer } from '../lib/use-result-announcer';
import { useUrlState } from '../lib/use-url-state';
import LedgerCellDetail from './ledger/LedgerCellDetail';
import { periodLabel } from './ledger/period-label';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Matches the server's `@IsIn` list in `list-ledger-cells.request.dto.ts`.
const SORT_FIELDS: readonly LedgerCellSortField[] = ['entity', 'measure', 'period'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

// Exactly the period-key forms the API writes (src/features/evidence/facts/derive-period.ts):
// a month (YYYY-MM), a quarter (YYYY-Qn), a year (YYYY), a fiscal year (FYYYYY), the undated
// sentinel, or an unparseable stated period (undated:<text>). The API never writes a half year.
const PERIOD_PATTERN = /^(?:\d{4}-(?:0[1-9]|1[0-2])|\d{4}-Q[1-4]|\d{4}|FY\d{4}|undated(?::.+)?)$/;
const PERIOD_ERROR =
  'Enter a month, quarter, year or fiscal year, for example 2025-03, 2025-Q1, 2025 or FY2025.';

// Declared at module scope, matching every other list page's `URL_DEFAULTS` — `useUrlState`
// adopts this once on mount and keeps that identity for the hook's lifetime.
const URL_DEFAULTS: Record<
  'entity' | 'measure' | 'state' | 'period' | 'skip' | 'selected' | 'limit' | 'sort' | 'sortDir',
  string
> = {
  entity: '',
  measure: '',
  state: '',
  period: '',
  skip: '0',
  selected: '',
  limit: '25',
  sort: 'entity',
  sortDir: 'asc',
};

const STATE_OPTIONS: { value: LedgerCellState | ''; label: string }[] = [
  { value: '', label: 'All states' },
  { value: 'single', label: 'Single' },
  { value: 'adjudicated', label: 'Adjudicated' },
  { value: 'conflicted', label: 'Conflicted' },
  { value: 'unknown', label: 'Unknown' },
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
  const periodFormatId = useId();
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedEntity = urlState.entity;
  const appliedMeasure = urlState.measure;
  const appliedState = urlState.state as LedgerCellState | '';
  const appliedPeriod = urlState.period;
  const skip = clampSkip(urlState.skip);
  const selected = urlState.selected;
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  const sort = pickOption(urlState.sort, SORT_FIELDS, 'entity');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'asc');
  // A `limit` outside the offered sizes — hand-edited, or carried over from an older link — falls
  // back to the default rather than paging the API at an arbitrary or unparseable size.
  const pageSize = clampPageSize(urlState.limit, PAGE_SIZE_OPTIONS, Number(URL_DEFAULTS.limit));

  const [periodError, setPeriodError] = useState<string | undefined>(undefined);
  const announceResult = useResultAnnouncer();

  // Every text filter writes the URL itself, resetting paging and the selected cell — only when
  // the value actually changed, so a flush of an untouched draft is a no-op.
  function applyEntity(value: string) {
    if (value === appliedEntity) return;
    setUrlState({ entity: value, skip: URL_DEFAULTS.skip, selected: URL_DEFAULTS.selected });
  }

  // A period that does not read as one of the API's period-key forms never applies: the field
  // keeps whatever the operator typed, and the inline error names the forms the hint already
  // describes, without moving focus off the field.
  function applyPeriod(value: string) {
    if (value !== '' && !PERIOD_PATTERN.test(value)) {
      setPeriodError(PERIOD_ERROR);
      return;
    }
    setPeriodError(undefined);
    if (value === appliedPeriod) return;
    setUrlState({ period: value, skip: URL_DEFAULTS.skip, selected: URL_DEFAULTS.selected });
  }

  const entityFilter = useDebouncedApply(appliedEntity, applyEntity);
  const periodFilter = useDebouncedApply(appliedPeriod, applyPeriod);

  function flushOnEnter(flush: () => void) {
    return (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') flush();
    };
  }

  const [cells, setCells] = useState<LedgerCell[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [measureLabels, setMeasureLabels] = useState<Record<string, string>>({});
  const [measureCanonicalUnits, setMeasureCanonicalUnits] = useState<Record<string, string>>({});
  const [measureOptions, setMeasureOptions] = useState<{ value: string; label: string }[]>([]);

  // The confirmed-measure vocabulary for the filter's Select, every row's Measure column, and the
  // canonical unit a resolved value's tooltip and drawer carry — fetched once, independent of the
  // cell filters. A failed fetch leaves all three empty rather than blocking the page: a slug
  // renders in place of a label, a canonical value renders unitless, and the filter offers only
  // "All measures". 100 is the server's max page size — a tenant confirming more than 100
  // measures sees a truncated filter, a recorded bound rather than a paged fetch here.
  useEffect(() => {
    listMeasures({ status: 'confirmed', limit: 100 })
      .then(({ docs }) => {
        setMeasureLabels(Object.fromEntries(docs.map((measure) => [measure.slug, measure.label])));
        setMeasureCanonicalUnits(
          Object.fromEntries(docs.map((measure) => [measure.slug, measure.canonicalUnit])),
        );
        setMeasureOptions(docs.map((measure) => ({ value: measure.slug, label: measure.label })));
      })
      .catch(() => {});
  }, []);

  // A deep link or a stale filter can name a measure the confirmed-vocabulary fetch never
  // returned — prepending it keeps the Select showing the same slug the applied filter is
  // actually using, rather than silently falling back to a blank or mismatched option.
  const measureSelectOptions =
    appliedMeasure && !measureOptions.some((option) => option.value === appliedMeasure)
      ? [{ value: appliedMeasure, label: appliedMeasure }, ...measureOptions]
      : measureOptions;

  // Identifies which applied filter values the rows on screen belong to, so a changed filter
  // announces its result once the fetch settles while a same-filter refresh (paging, sorting)
  // stays silent.
  const filterKey = JSON.stringify([appliedEntity, appliedMeasure, appliedState, appliedPeriod]);

  useEffect(() => {
    let cancelled = false;

    listLedgerCells({
      skip,
      limit: pageSize,
      entity: appliedEntity || undefined,
      measure: appliedMeasure || undefined,
      state: appliedState || undefined,
      period: appliedPeriod || undefined,
      sort,
      sortDir,
    })
      .then(({ docs, count: total }) => {
        if (cancelled) return;
        setCells(docs);
        setCount(total);
        setError(null);
        announceResult(filterKey, `${total} cell${total === 1 ? '' : 's'}`);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load ledger cells');
      });

    return () => {
      cancelled = true;
    };
  }, [
    skip,
    pageSize,
    appliedEntity,
    appliedMeasure,
    appliedState,
    appliedPeriod,
    sort,
    sortDir,
    filterKey,
    announceResult,
  ]);

  // Clearing filters closes the facts drawer even when the selected cell is still on the new
  // page — the selection belongs to the filters it was made under. `reset` clears each text
  // draft and its armed timer directly, since a filter already reading as the default leaves the
  // URL unchanged and no applied value for the draft to re-sync from.
  function handleClearFilter() {
    setPeriodError(undefined);
    entityFilter.reset(URL_DEFAULTS.entity);
    periodFilter.reset(URL_DEFAULTS.period);
    setUrlState({
      entity: URL_DEFAULTS.entity,
      measure: URL_DEFAULTS.measure,
      state: URL_DEFAULTS.state,
      period: URL_DEFAULTS.period,
      skip: URL_DEFAULTS.skip,
      selected: URL_DEFAULTS.selected,
      sort: URL_DEFAULTS.sort,
      sortDir: URL_DEFAULTS.sortDir,
    });
  }

  function handleSort(field: LedgerCellSortField) {
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  const hasFilter =
    appliedEntity !== URL_DEFAULTS.entity ||
    appliedMeasure !== URL_DEFAULTS.measure ||
    appliedState !== URL_DEFAULTS.state ||
    appliedPeriod !== URL_DEFAULTS.period;

  const selectedCell = cells?.find((cell) => cellKey(cell) === selected) ?? null;

  // The drawer's own title names the cell, which is why the detail body carries no heading. A
  // period with no display form leaves the segment off rather than printing a sentinel.
  let drawerTitle = '';
  if (selectedCell) {
    const measure = measureLabels[selectedCell.measure] ?? selectedCell.measure;
    const period = periodLabel(selectedCell.period);
    drawerTitle = `${selectedCell.entity} · ${measure}${period ? ` · ${period}` : ''}`;
  }

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
        <FilterBar label="Ledger filters" onClear={handleClearFilter} hasFilter={hasFilter}>
          <Input
            label="Entity"
            width="grow"
            value={entityFilter.draft}
            onChange={entityFilter.setDraft}
            onKeyDown={flushOnEnter(entityFilter.flush)}
          />
          <Select
            label="Measure"
            options={[{ value: '', label: 'All measures' }, ...measureSelectOptions]}
            value={appliedMeasure}
            onChange={(value) =>
              setUrlState({
                measure: value,
                skip: URL_DEFAULTS.skip,
                selected: URL_DEFAULTS.selected,
              })
            }
          />
          <Select
            label="State"
            options={STATE_OPTIONS}
            value={appliedState}
            onChange={(value) =>
              setUrlState({
                state: value,
                skip: URL_DEFAULTS.skip,
                selected: URL_DEFAULTS.selected,
              })
            }
          />
          {/* The period format is a description, not a visible hint: a visible hint would add
              height below this control in a row whose controls share one bottom edge. */}
          <>
            <Input
              label="Period"
              width="sm"
              placeholder="2025-Q1"
              value={periodFilter.draft}
              onChange={periodFilter.setDraft}
              onKeyDown={flushOnEnter(periodFilter.flush)}
              aria-describedby={periodFormatId}
              error={periodError}
            />
            <span id={periodFormatId} className="sr-only">
              Format: a month, quarter, year or fiscal year, for example 2025-03, 2025-Q1, 2025 or
              FY2025.
            </span>
          </>
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
            pageSize={pageSize}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
            onPageSizeChange={(next) =>
              setUrlState({ limit: String(next), skip: URL_DEFAULTS.skip })
            }
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        )
      }
    >
      {cells && cells.length > 0 && (
        <Panel aria-label="Ledger cells">
          <Table caption="Entity, measure and period cells with their resolved state">
            <thead>
              <tr>
                <SortableHeaderCell<LedgerCellSortField>
                  field="entity"
                  label="Entity"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<LedgerCellSortField>
                  field="measure"
                  label="Measure"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<LedgerCellSortField>
                  field="period"
                  label="Period"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell className="cell-numeric">Value</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Facts</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {cells.map((cell) => {
                const measureLabel = measureLabels[cell.measure] ?? cell.measure;
                const canonicalValue = cell.value
                  ? formatCanonicalValue(cell.value, measureCanonicalUnits[cell.measure])
                  : undefined;
                return (
                  <TableRow key={cellKey(cell)} selected={cellKey(cell) === selected}>
                    <TableCell label="Entity">{cell.entity}</TableCell>
                    <TableCell label="Measure">{measureLabel}</TableCell>
                    <TableCell label="Period">{periodLabel(cell.period) ?? '—'}</TableCell>
                    <TableCell label="Value" className="cell-numeric">
                      {cell.value ? (
                        canonicalValue !== undefined ? (
                          <Tooltip content={canonicalValue}>
                            {/* Focusable so keyboard focus opens the canonical-value tooltip. */}
                            <span className="mono" tabIndex={0}>
                              {formatMeasureValue(cell.value)}
                            </span>
                          </Tooltip>
                        ) : (
                          <span className="mono">{formatMeasureValue(cell.value)}</span>
                        )
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell label="State">
                      <Badge tone={STATE_TONE[cell.state]}>{cell.state}</Badge>
                    </TableCell>
                    <TableCell label="Facts" className="cell-actions">
                      <div className="form-actions">
                        <span className="mono cell-sub">{cell.factIds.length}</span>
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`View facts for ${cell.entity} · ${measureLabel}`}
                          onClick={() => setUrlState({ selected: cellKey(cell) })}
                        >
                          View facts
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        </Panel>
      )}

      {/* The child is keyed, not the drawer: switching cells replaces the detail's state without
          re-animating the sheet or losing the operator's place. */}
      <Drawer
        open={selectedCell !== null}
        onClose={() => setUrlState({ selected: URL_DEFAULTS.selected })}
        title={drawerTitle}
        size="lg"
      >
        {selectedCell && (
          <LedgerCellDetail
            key={cellKey(selectedCell)}
            cell={selectedCell}
            canonicalUnit={measureCanonicalUnits[selectedCell.measure]}
          />
        )}
      </Drawer>
    </RecordListPage>
  );
}
