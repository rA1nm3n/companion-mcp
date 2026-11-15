import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import { SatelliteError } from './errors.js';

/** Satellite ports are fixed in Companion 5.1.3 (not configurable). */
export const DEFAULT_TCP_PORT = 16622;
export const DEFAULT_WS_PORT = 16623;

/** Maximum accepted server line. KEY-STATE lines with 96 px RGB bitmaps are about 37 kB. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface LineTransport {
  /** Receives decoded text chunks (TCP) or whole frames (WebSocket). */
  onData: (text: string) => void;
  /** Called once when the connection ends, with the error if it ended abnormally. */
  onClose: (error?: Error) => void;
  connect(host: string, port: number, timeoutMs: number): Promise<void>;
  send(text: string): void;
  /** Graceful close. */
  close(): void;
  /** Immediate teardown. */
  destroy(): void;
}

/** Splits a text stream into lines (`\n`, `\r\n` tolerated) and enforces a maximum line length. */
export class LineSplitter {
  #buffer = '';
  readonly #maxChars: number;

  constructor(maxChars: number = MAX_LINE_BYTES) {
    this.#maxChars = maxChars;
  }

  /** Throws `LINE_TOO_LONG` if a line without terminator exceeds the limit. */
  push(text: string): string[] {
    this.#buffer += text;
    const lines: string[] = [];
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      let line = this.#buffer.slice(0, index);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf('\n');
    }
    if (this.#buffer.length > this.#maxChars) {
      this.#buffer = '';
      throw new SatelliteError('LINE_TOO_LONG', `Server line exceeds ${this.#maxChars} characters`);
    }
    return lines;
  }
}

export class TcpTransport implements LineTransport {
  onData: (text: string) => void = () => undefined;
  onClose: (error?: Error) => void = () => undefined;
  #socket: net.Socket | undefined;
  #closed = false;

  connect(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      this.#socket = socket;
      socket.setNoDelay(true);
      const decoder = new StringDecoder('utf8');
      let connected = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new SatelliteError(
            'CONNECT_TIMEOUT',
            `No TCP connection to ${host}:${port} within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      socket.on('connect', () => {
        connected = true;
        clearTimeout(timer);
        resolve();
      });
      socket.on('data', (chunk: Buffer) => this.onData(decoder.write(chunk)));
      socket.on('error', (error) => {
        clearTimeout(timer);
        if (!connected) {
          reject(
            new SatelliteError(
              'CONNECT_FAILED',
              `Cannot connect to ${host}:${port}: ${error.message}`,
              {
                cause: error,
              },
            ),
          );
        } else this.#finish(error);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!connected) return;
        this.#finish();
      });
    });
  }

  #finish(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose(error);
  }

  send(text: string): void {
    const socket = this.#socket;
    if (!socket || socket.destroyed || !socket.writable) {
      throw new SatelliteError('CONNECTION_LOST', 'Socket is not writable');
    }
    socket.write(text);
  }

  close(): void {
    this.#socket?.end();
  }

  destroy(): void {
    this.#socket?.destroy();
  }
}

/** WebSocket variant (port 16623, one text frame per message, still line based). */
export class WsTransport implements LineTransport {
  onData: (text: string) => void = () => undefined;
  onClose: (error?: Error) => void = () => undefined;
  #ws: WebSocket | undefined;
  #closed = false;

  connect(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      // No Origin header is sent. Companion does not check it (measured), which is a risk, see docs/satellite.md.
      const ws = new WebSocket(`ws://${authority}:${port}`, {
        handshakeTimeout: timeoutMs,
        maxPayload: MAX_LINE_BYTES,
      });
      this.#ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        resolve();
      });
      ws.on('message', (data: WebSocket.RawData) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data as Buffer).toString('utf8');
        this.onData(text);
      });
      ws.on('error', (error) => {
        if (!opened) {
          const timedOut = /timed out|timeout/i.test(error.message);
          reject(
            new SatelliteError(
              timedOut ? 'CONNECT_TIMEOUT' : 'CONNECT_FAILED',
              `Cannot connect to ws://${authority}:${port}: ${error.message}`,
              { cause: error },
            ),
          );
        } else this.#finish(error);
      });
      ws.on('close', () => {
        if (opened) this.#finish();
      });
    });
  }

  #finish(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose(error);
  }

  send(text: string): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new SatelliteError('CONNECTION_LOST', 'WebSocket is not open');
    }
    ws.send(text);
  }

  close(): void {
    this.#ws?.close();
  }

  destroy(): void {
    this.#ws?.terminate();
  }
}
