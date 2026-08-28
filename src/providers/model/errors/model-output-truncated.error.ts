/** Caps the excerpt kept on `raw` at this many characters — long enough to see what the model was
 *  mid-way through writing, short enough that this error never itself carries an unbounded amount
 *  of model output — including a quote lifted from a tenant's document, which a truncated
 *  `verify_claims` verdict can begin with. */
const RAW_EXCERPT_MAX_CHARS = 300;

function excerptRaw(raw: string): string {
  if (raw.length <= RAW_EXCERPT_MAX_CHARS) {
    return raw;
  }
  return `${raw.slice(0, RAW_EXCERPT_MAX_CHARS)}… [excerpt truncated, ${raw.length} chars total]`;
}

/**
 * The fix for a stopped generation depends on why it stopped: hitting the `maxTokens` output cap
 * is fixed by raising it, but exceeding the model's context window is not — the window is already
 * full, so a longer `maxTokens` cannot help and only makes the retry's prompt larger.
 */
function adviceForStopReason(stopReason: string): string {
  return stopReason === 'model_context_window_exceeded'
    ? 'Reduce the prompt for this call — the context window is already full, so raising maxTokens cannot help.'
    : 'Raise maxTokens for this call — retrying at the same cap cannot succeed.';
}

/**
 * Thrown once a model response has both failed JSON parsing/schema validation and stopped
 * generating early — at the `maxTokens` output cap, or (Anthropic only) because continuing would
 * have exceeded the model's context window — rather than completing normally.
 * `AnthropicModelProvider` and `OpenAiModelProvider` raise this instead of entering the
 * schema-validation retry: either cause makes the response incomplete by construction, and
 * retrying under the same constraint against a strictly longer prompt reproduces the same cutoff
 * rather than resolving it. A response that stopped for one of these reasons but still parses and
 * validates is returned normally — a valid response is valid regardless of why generation stopped.
 *
 * `message` never carries model output, unlike this error's `raw` field: a truncated response can
 * begin mid-quote from a tenant's document, and `message` is what operator-facing logs render
 * verbatim.
 */
export class ModelOutputTruncatedError extends Error {
  public readonly raw: string;

  constructor(
    public readonly stopReason: string,
    public readonly maxTokens: number,
    public readonly outputTokens: number,
    raw: string,
  ) {
    super(
      `Model generation stopped before producing a parseable response (maxTokens=${maxTokens}, ` +
        `stop reason "${stopReason}", ${outputTokens} output token(s) produced). ` +
        `${adviceForStopReason(stopReason)}`,
    );
    this.name = 'ModelOutputTruncatedError';
    this.raw = excerptRaw(raw);
  }
}
