/**
 * Not a `BaseException`/`HttpException` — the provider layer runs outside HTTP request scope
 * (Temporal activities, `scripts/`, and eventually an eval runner), so it cannot assume a
 * controller is there to catch it. Callers that do sit behind a controller are responsible for
 * mapping this to an HTTP response themselves.
 *
 * Thrown when a `tool_calls` entry's `function.arguments` string does not parse as JSON. OpenAI
 * returns tool-call arguments as a JSON-encoded string rather than an object; a value that fails
 * to parse is a malformed response from the vendor, not a shape `ModelToolCall.input` can carry —
 * this fails the call rather than propagating the unparsed string or letting `JSON.parse` throw
 * uncaught.
 */
export class OpenAiMalformedToolArgumentsError extends Error {
  constructor(
    public readonly toolCallId: string,
    public readonly toolName: string,
    public readonly rawArguments: string,
    public readonly parseError: unknown,
  ) {
    super(
      `OpenAI tool call '${toolName}' (${toolCallId}) returned arguments that do not parse as JSON: ${rawArguments}`,
    );
    this.name = 'OpenAiMalformedToolArgumentsError';
  }
}
