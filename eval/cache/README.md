# Eval replay cache

`model/` and `embedding/` hold record/replay fixtures for `npm run eval` (default: replay-only,
zero API cost, byte-stable — see `docs/adr/0007-eval-replay-cache.md`).

- `model/<sha256>.json` — one `ModelResult` per distinct (provider, model, params, prompt, output
  schema) request, written by `CachingModelProvider` (`src/providers/model/caching-model.provider.ts`).
- `embedding/<sha256>.json` — one `EmbeddingResult` per distinct (provider, model, dimensions,
  inputType, inputs) request, written by `CachingEmbeddingProvider`
  (`eval/providers/caching-embedding.provider.ts`).
- `manifest.json` — the corpus fingerprint (sha256 over the tenant's sorted `evidence_chunks._id`
  values, `eval/compute-corpus-fingerprint.ts`) recorded alongside the prompt/embedding fixtures
  above. `run.ts` asserts this on every replay, before touching a single case, because ingestion is
  reuse-by-default (`--ingest` opts back in) and a corpus that drifted from what was recorded would
  otherwise surface as a confusing per-prompt cache miss deep in the run instead of one clear
  failure at the top.

Populating these requires live `ANTHROPIC_API_KEY`/`VOYAGE_API_KEY` and a reachable Mongo
(`npm run eval -- --record`) — neither is available inside a sandboxed implementation session, so
recording is always an operator-run step.

A partially-recorded cache is the normal state during development, and `npm run eval` in the
default replay mode fails loudly with `ModelReplayCacheMissError`/`EmbeddingReplayCacheMissError`
on the first request it has no fixture for. That failure is the intended behaviour — never a silent
live call — not a bug. It also means the cache is only as complete as the last `--record` run got:
a run that died partway leaves the entries it had already written, which is why the counts here can
grow without the eval yet producing results.

Once recorded, both directories are committed: CI runs `npm run eval` replay-only, at zero cost.
Re-record deliberately (`--record`) after any change to the corpus, the dataset questions, the
prompt templates, or the model/embedding version — a stale cache entry silently freezes the
old behaviour for whichever request key didn't change.
