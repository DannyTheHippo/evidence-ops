/**
 * Test double for `EventSource`, installed per-test with `vi.stubGlobal('EventSource',
 * FakeEventSource)`. It deliberately does NOT simulate the browser's automatic reconnect on a
 * transport error — the unit under test is `useEventStream`'s own close-and-fall-back logic, not
 * browser internals, so a caller drives every retry explicitly via `emitConnectionError()`, which
 * dispatches a bare `error` event and leaves `readyState` untouched (a retryable blip). It does
 * model the one piece of browser retry semantics the hook itself branches on: a hard failure
 * closes the socket for good before the browser ever fires `error`, so `failConnection()` sets
 * `readyState = 2` (`CLOSED`) first and dispatches `error` after.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  readonly url: string;
  readyState = 0;
  closed = false;

  private readonly target = new EventTarget();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, handler: EventListenerOrEventListenerObject): void {
    this.target.addEventListener(name, handler);
  }

  removeEventListener(name: string, handler: EventListenerOrEventListenerObject): void {
    this.target.removeEventListener(name, handler);
  }

  emit(name: string, data: unknown): void {
    this.target.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }

  // Bypasses the `JSON.stringify` in `emit()` so a test can dispatch a frame whose payload is not
  // valid JSON, e.g. a truncated server-sent chunk.
  emitRaw(name: string, rawData: string): void {
    this.target.dispatchEvent(new MessageEvent(name, { data: rawData }));
  }

  emitConnectionError(): void {
    this.target.dispatchEvent(new Event('error'));
  }

  failConnection(): void {
    this.readyState = 2;
    this.target.dispatchEvent(new Event('error'));
  }

  close(): void {
    this.readyState = 2;
    this.closed = true;
  }
}
