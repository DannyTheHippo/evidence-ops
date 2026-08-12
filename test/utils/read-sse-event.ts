import type { INestApplication } from '@nestjs/common';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SseEventResult {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly data: unknown;
}

/**
 * Reads a `text/event-stream` response until a frame named `eventName` arrives, parses its
 * `data:` payload as JSON, then destroys the connection — used by the SSE e2e cases in
 * `qa.e2e-spec.ts`, `approvals.e2e-spec.ts` (workflow-runs), and `documents.e2e-spec.ts`.
 *
 * Bypasses supertest/superagent entirely: superagent's `Request` only emits its own `'response'`
 * event from `_emitResponse()` once the full body has been parsed (`superagent/lib/node/index.js`)
 * — for the streams under test here (`streamAnswer`/`streamRun`/`streamList`), the body never
 * completes on its own, so that event would never fire. Raw `node:http` gives headers the moment
 * they arrive and a socket this function can destroy on its own schedule.
 *
 * The connection is destroyed on every exit path — success, the fail-fast timeout, or a thrown
 * assertion in the caller after this resolves. An SSE socket left open here would not fail the
 * *test* (the promise still settles); it would instead make `closeTestApp`'s `app.close()` in the
 * suite's `afterAll` wait for that connection to drain, which never happens on its own, stalling
 * the whole Jest worker rather than just this one case.
 */
export const readSseEvent = (
  app: INestApplication,
  path: string,
  eventName: string,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<SseEventResult> => {
  const httpServer = app.getHttpServer() as http.Server;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let req: http.ClientRequest;
    let res: http.IncomingMessage | undefined;

    const cleanup = (): void => {
      res?.removeAllListeners('error');
      res?.destroy();
      req.removeAllListeners('error');
      req.destroy();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timed out waiting for SSE event '${eventName}' on '${path}'`));
    }, timeoutMs);

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn();
    };

    const dispatch = (port: number): void => {
      req = http.get({ host: '127.0.0.1', port, path, headers }, (response) => {
        res = response;
        response.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          // Re-split the whole accumulated buffer on every chunk rather than tracking an
          // incremental cursor — a chunk can land mid-frame, and this stays correct regardless
          // of where the split falls. The final element is dropped: it is either empty or a
          // still-incomplete trailing frame.
          const frames = buffer.split('\n\n').slice(0, -1);
          for (const frame of frames) {
            const lines = frame.split('\n');
            const frameEvent = lines
              .find((line) => line.startsWith('event: '))
              ?.slice('event: '.length);
            if (frameEvent !== eventName) continue;

            const dataLines = lines
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice('data: '.length));
            settle(() =>
              resolve({
                statusCode: response.statusCode ?? 0,
                headers: response.headers,
                data: JSON.parse(dataLines.join('\n')) as unknown,
              }),
            );
            return;
          }
        });
        response.on('error', () => {
          // Expected once `cleanup()` destroys the response mid-stream.
        });
      });
      req.on('error', () => {
        // Expected once `cleanup()` destroys the request mid-stream.
      });
    };

    const address = httpServer.address();
    if (address && typeof address === 'object') {
      dispatch(address.port);
    } else {
      httpServer.listen(0, () => dispatch((httpServer.address() as AddressInfo).port));
    }
  });
};
