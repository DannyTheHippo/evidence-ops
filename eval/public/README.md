# Public-corpus eval lane

The third eval lane (`eval/run.ts`'s `--lane public`, `eval/lanes.ts`) measures the product against
SEC EDGAR REIT 10-K/10-Q filings — documents nobody in this repository authored — under its own
tenant, `eval-public`. Unlike the `benchmark` lane, the dataset here is public: no client content is
involved, so nothing under this directory needs the confidentiality boundary `eval/benchmark/`
carries. What still needs excluding is content this lane can only reproduce by re-fetching or
re-recording, never content that must stay secret.

## Tracked vs. ignored

Tracked (committed, because the claims rewrite in the phase that measures this lane cites them):

- `dataset/cases.json`, `dataset/manifest.json` — the frozen case set and its `casesSha256`.
- `corpus-manifest.json` — every fetched file's path, role, source URL, sha256 and `selected` flag.
- `bars.json` — the pre-registered hard bars, reported metrics and dataset minimums.
- `measures.json` — the REIT measures confirmed for the `eval-public` tenant before extraction.
- `results/` — clean-sha scoring, variance and verifier results (`*-dirty.*` stays excluded, same
  rule as the synthetic and benchmark lanes).
- This file.

Ignored (`.gitignore`, `/eval/public/corpus/` and `/eval/public/cache/`):

- `corpus/` — the fetched filing bytes, the XBRL companyfacts JSON
  (`corpus/xbrl/CIK<10 digits>.json`) and the ingest ledger (`corpus/ingest-ledger.json`). Five
  hundred filings do not belong in git, and a re-fetch against the same allowlist and window
  reproduces the same manifest.
- `cache/` — record/replay fixtures for the public tenant's model and embedding calls, the same
  shape as `eval/cache/README.md` describes for the synthetic lane, excluded wholesale because
  ingest-time extraction fixtures over real filings run to tens of megabytes.

## Commands, in order

1. `npm run corpus:fetch -- --user-agent "<name> <email>"` — fetches submissions, filings and
   companyfacts for the allowlist in `scripts/public-corpus/lib/allowlist.ts`; resumable.
2. `npm run corpus:size` — zero-cost sizing probe over every fetched file; writes
   `results/sizing-<manifestSha8>.md`/`.json` and a recommended `SELECTION`.
3. `npm run eval:public:ingest -- --only <path prefix>` — one sample filing set, to get a measured
   $/chunk and s/chunk before the full ingest is sized.
4. `npm run eval:public:ingest -- --max-minutes <n>` — the full, resumable ingest loop, repeated
   until it prints `complete`.
5. `npm run corpus:author-numeric` — XBRL-derived numeric and restatement-conflict cases.
6. `npm run corpus:freeze` — merges hand-authored and generated cases, resolves every locator
   against the ingested corpus, and writes `dataset/cases.json`/`manifest.json`.
7. `npm run eval -- --lane public --record` (scoring), `npm run eval -- --lane public --variance
   --runs 5 [--resume]` (variance), `npm run experiment:verifier -- run --tenant eval-public`
   (verifier) — each an operator-run step, same as the synthetic lane's own `--record`.

## Re-recorded deliberately, never in CI

Every step above needs live `ANTHROPIC_API_KEY`/`VOYAGE_API_KEY`, a reachable Mongo, and — for the
fetch — network access to `data.sec.gov`/`www.sec.gov`. None of that is available inside a
sandboxed session, and none of it runs automatically: this lane is never wired into
`.github/workflows/**`, unlike the synthetic lane's replay-only `eval` job. A run against this lane
is always an operator-run step, re-recorded on purpose when the corpus, the dataset, the prompts, or
the model/embedding version change — the same discipline `eval/cache/README.md` documents for the
synthetic lane's cache.
