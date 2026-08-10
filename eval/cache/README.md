# Eval replay cache

`model/` and `embedding/` hold record/replay fixtures for `npm run eval` (default: replay-only,
zero API cost, byte-stable — see `docs/adr/0007-eval-replay-cache.md`).

- `model/<sha256>.json` — one `ModelResult` per distinct (provider, model, params, prompt, output
  schema) request, written by `CachingModelProvider` (`src/providers/model/caching-model.provider.ts`).
- `embedding/<sha256>.json` — one `EmbeddingResult` per distinct (provider, model, dimensions,
  inputType, inputs) request, written by `CachingEmbeddingProvider`
  (`eval/providers/caching-embedding.provider.ts`).

Both are currently **empty**: populating them requires live `ANTHROPIC_API_KEY`/`VOYAGE_API_KEY`
and a reachable Mongo (`npm run eval -- --record`), neither of which is available in a sandboxed
implementation session. `npm run eval` in the default replay mode will fail loudly with a
`ModelReplayCacheMissError`/`EmbeddingReplayCacheMissError` until a `--record` run populates these
directories — that failure is the intended fail-loud behaviour (never a silent live call), not a
bug.

Once recorded, both directories are committed: CI runs `npm run eval` replay-only, at zero cost.
Re-record deliberately (`--record`) after any change to the corpus, the dataset questions, the
prompt templates, or the model/embedding version — a stale cache entry silently freezes the
old behaviour for whichever request key didn't change.
