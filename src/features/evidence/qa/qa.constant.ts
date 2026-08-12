// Matches AskPage's poll interval (`web/src/pages/AskPage.tsx`'s DEFAULT_POLL_INTERVAL_MS) — the
// SSE stream this backs (`QaService.streamAnswer`) is a drop-in replacement for that polling loop,
// so it ticks at the same cadence the SPA already assumes.
export const ANSWER_STREAM_INTERVAL_MS = 1500;
