import { useEffect, useState } from 'react';
import { getMeasures, type Measures } from '../api/client';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';

// A null figure means nothing was measurable yet — rendering it as 0 or '—' would assert a
// measurement that never happened, so both formatters below spell it out instead.
function formatMean(value: number | null): string {
  return value === null ? 'No answers yet' : value.toFixed(1);
}

function formatLatency(value: number | null): string {
  return value === null ? 'No answers yet' : `${Math.round(value)} ms`;
}

interface MeasureRow {
  key: string;
  name: string;
  value: string;
  explanation: string;
}

function buildRows(measures: Measures): MeasureRow[] {
  return [
    {
      key: 'answersCompleted',
      name: 'Answers completed',
      value: String(measures.answersCompleted),
      explanation: 'Question runs that reached a final outcome, of any kind.',
    },
    {
      key: 'answersWithVerifiedCitations',
      name: 'Answers with verified citations',
      value: String(measures.answersWithVerifiedCitations),
      explanation:
        'Verified by construction — an answered outcome whose citations were all dropped is persisted as insufficient evidence instead.',
    },
    {
      key: 'conflictsSurfaced',
      name: 'Conflicts surfaced',
      value: String(measures.conflictsSurfaced),
      explanation: 'Conflicting-fact groups detected across the corpus.',
    },
    {
      key: 'conflictsResolved',
      name: 'Conflicts resolved',
      value: String(measures.conflictsResolved),
      explanation: 'Conflicts carried to a resolved status.',
    },
    {
      key: 'meanEvidenceDocumentsPerAnswer',
      name: 'Mean evidence documents per answer',
      value: formatMean(measures.meanEvidenceDocumentsPerAnswer),
      explanation:
        'Evidence documents, not sources — a browser-uploaded document has no source to count.',
    },
    {
      key: 'medianAnswerLatencyMs',
      name: 'Median answer latency',
      value: formatLatency(measures.medianAnswerLatencyMs),
      explanation: 'Time from question submitted to answer completed, 50th percentile.',
    },
    {
      key: 'p95AnswerLatencyMs',
      name: 'p95 answer latency',
      value: formatLatency(measures.p95AnswerLatencyMs),
      explanation: 'Time from question submitted to answer completed, 95th percentile.',
    },
  ];
}

export default function MeasuresPage() {
  const [measures, setMeasures] = useState<Measures | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMeasures()
      .then((result) => {
        setMeasures(result);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load measures');
      });
  }, []);

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Overview</span>
          <h1 className="page-title">Measures</h1>
          <p className="page-sub">
            Pilot measures, each traceable to what it counts — no interview-derived baselines.
          </p>
        </div>
      </div>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!measures && !error && <Skeleton label="Loading measures…" />}

      {/* A table, not a card list: every row is a fixed measure with no action and no per-item
          state, so there is nothing for a card to earn — the one thing worth optimizing for is
          scanning seven numbers in a single aligned column, which `.num`'s tabular numerals give
          for free and a stacked list would not. */}
      {measures && (
        <section className="panel">
          <Table caption="Pilot measures">
            <thead>
              <tr>
                <TableHeaderCell>Measure</TableHeaderCell>
                <TableHeaderCell>Value</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {buildRows(measures).map((row) => (
                <tr key={row.key}>
                  <TableCell label="Measure">
                    {row.name}
                    <div className="cell-sub">{row.explanation}</div>
                  </TableCell>
                  <TableCell label="Value" className="num">
                    {row.value}
                  </TableCell>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
    </div>
  );
}
