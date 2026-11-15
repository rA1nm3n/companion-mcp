import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface RecordedCall {
  /** Index of the WebSocket connection (0-based, in connect order). */
  connection: number;
  method: string;
  path: string;
  input: unknown;
}

export class MockRemoteError extends Error {
  constructor(
    message: string,
    readonly remoteCode = 'INTERNAL_SERVER_ERROR',
  ) {
    super(message);
  }
}

/** Return this symbol from a handler to never answer (timeout tests). */
export const NO_RESPONSE = Symbol('no-response');
/** Return this symbol to make the server drop the connection instead of answering. */
export const DROP_CONNECTION = Symbol('drop-connection');

export type Handler = (
  input: unknown,
  info: { connection: number; method: string },
) => unknown | Promise<unknown>;

export interface MockServer {
  url: string;
  calls: RecordedCall[];
  /** Number of `PONG` frames received from clients. */
  pongs: { count: number };
  handlers: Map<string, Handler>;
  /** Items delivered for subscriptions (first item is the one a client reads). */
  setHandler(path: string, handler: Handler): void;
  sendRaw(text: string): void;
  close(): Promise<void>;
}

/** Local tRPC-like WebSocket server speaking the measured wire format. Subscriptions answer with one data item. */
export async function startMockServer(
  httpRoutes: Record<string, unknown> = {},
): Promise<MockServer> {
  const calls: RecordedCall[] = [];
  const pongs = { count: 0 };
  const handlers = new Map<string, Handler>();
  const sockets: WebSocket[] = [];
  const http: Server = createServer((req, res) => {
    const route = httpRoutes[req.url ?? ''];
    if (route === undefined) {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(route));
  });
  const wss = new WebSocketServer({ server: http, path: '/trpc' });

  wss.on('connection', (socket) => {
    const connection = sockets.length;
    sockets.push(socket);
    socket.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'PONG') {
        pongs.count++;
        return;
      }
      const msg = JSON.parse(text) as {
        id: number;
        method: string;
        params?: { path: string; input: unknown };
      };
      if (msg.method === 'subscription.stop') {
        socket.send(JSON.stringify({ id: msg.id, result: { type: 'stopped' } }));
        return;
      }
      const path = msg.params?.path ?? '';
      calls.push({ connection, method: msg.method, path, input: msg.params?.input });
      const handler = handlers.get(path);
      void (async () => {
        if (!handler) {
          socket.send(
            JSON.stringify({
              id: msg.id,
              error: {
                message: `No "${msg.method}"-procedure on path "${path}"`,
                code: -32004,
                data: { code: 'NOT_FOUND', httpStatus: 404, path },
              },
            }),
          );
          return;
        }
        try {
          const value = await handler(msg.params?.input, { connection, method: msg.method });
          if (value === NO_RESPONSE) return;
          if (value === DROP_CONNECTION) {
            socket.terminate();
            return;
          }
          if (msg.method === 'subscription') {
            socket.send(JSON.stringify({ id: msg.id, result: { type: 'started' } }));
          }
          socket.send(JSON.stringify({ id: msg.id, result: { type: 'data', data: value } }));
        } catch (error) {
          const remote =
            error instanceof MockRemoteError ? error : new MockRemoteError(String(error));
          socket.send(
            JSON.stringify({
              id: msg.id,
              error: {
                message: remote.message,
                code: -32603,
                data: { code: remote.remoteCode, httpStatus: 500, path },
              },
            }),
          );
        }
      })();
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    pongs,
    handlers,
    setHandler: (path, handler) => handlers.set(path, handler),
    sendRaw: (text) => {
      for (const s of sockets) s.send(text);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

export function installDefaultHandlers(server: MockServer, version = '5.1.3'): void {
  server.setHandler('appInfo.version', () => ({
    appVersion: version,
    appBuild: `${version}+test`,
  }));
}
