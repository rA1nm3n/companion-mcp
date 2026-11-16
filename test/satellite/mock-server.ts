import net from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { parseLine } from '../../src/satellite/protocol.js';

/**
 * Mock Companion Satellite server (API 1.14.0) that replays the behaviour measured on Companion 5.1.3:
 * BEGIN/CAPS first, ADD-DEVICE OK then BRIGHTNESS and an unordered KEY-STATE flood, `KEY-PRESS OK` for
 * everything (also empty keys and locked surfaces), idle timeout, PING answered with PONG, unknown commands
 * answered with `ERROR MESSAGE="Unknown command: X"`, and never a server-side PING.
 *
 * Layout of page 1 (8 keys per row):
 *   0/0 "SET" green, sets the variable on press and turns 0/0 and 0/1 red (feedback)
 *   0/1 "RESET" blue
 *   0/3 "FLICK": looks different only while held, identical after the release
 *   1/0 "UP": page navigation key, switches to page 2
 *   everything else is empty.
 * Page 2: 0/0 "P2" (all other keys empty). With `latePageKeyDelayMs` key 31 arrives that late after a page change.
 */

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export interface MockOptions {
  kind?: 'tcp' | 'ws';
  apiVersion?: string;
  subscriptions?: boolean;
  /** Close connections after this many ms without client data (Companion: 5000). */
  idleTimeoutMs?: number;
  /** Delay before BEGIN is sent. */
  beginDelayMs?: number;
  /** Do not send BEGIN at all. */
  silent?: boolean;
  /** Start locked: LOCKED-STATE LOCKED=1, no KEY-STATE. */
  locked?: boolean;
  /** Never answer ADD-DEVICE (duplicate DEVICEID connected elsewhere). */
  ignoreAddDevice?: boolean;
  /** Answer ADD-DEVICE with an ERROR. */
  rejectAddDevice?: string;
  /** Delay for the last KEY-STATE after a page change. */
  latePageKeyDelayMs?: number;
  /** Record KEY-PRESS but never answer it. */
  ignoreKeyPress?: boolean;
  /** Do not answer PING. */
  ignorePing?: boolean;
  /** Send the whole ADD-DEVICE answer as CRLF lines. */
  crlf?: boolean;
  /** CAPS BITMAP_FORMATS value. */
  bitmapFormats?: string;
}

interface KeyView {
  text: string;
  color: string;
  pressed?: boolean;
}

interface Session {
  send(line: string): void;
  end(): void;
  destroy(): void;
  deviceId: string | null;
  keysTotal: number;
  keysPerRow: number;
  bitmaps: string | null;
  bitmapFormat: string | null;
  page: number;
  variable: number;
  lockedNow: boolean;
  held: Set<number>;
}

export class MockSatelliteServer {
  readonly received: string[] = [];
  readonly sessions: Session[] = [];
  port = 0;
  #server: net.Server | undefined;
  #wss: WebSocketServer | undefined;
  readonly options: MockOptions;
  #sockets = new Set<net.Socket>();

  constructor(options: MockOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    if ((this.options.kind ?? 'tcp') === 'ws') {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      this.#wss = wss;
      await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
      this.port = (wss.address() as net.AddressInfo).port;
      wss.on('connection', (socket: WsSocket) => {
        let buffer = '';
        const session = this.#newSession(
          (line) => socket.send(`${line}\n`),
          () => socket.close(),
          () => socket.terminate(),
        );
        socket.on('message', (data) => {
          buffer += Buffer.from(data as Buffer).toString('utf8');
          let index = buffer.indexOf('\n');
          while (index !== -1) {
            this.#handle(session, buffer.slice(0, index).replace(/\r$/, ''));
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
          }
        });
      });
      return;
    }
    const server = net.createServer((socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.setEncoding('utf8');
      socket.setNoDelay(true);
      if (this.options.idleTimeoutMs !== undefined) {
        socket.setTimeout(this.options.idleTimeoutMs, () => socket.destroy());
      }
      const session = this.#newSession(
        (line) => {
          if (!socket.destroyed) socket.write(`${line}${this.options.crlf ? '\r' : ' '}\n`);
        },
        () => socket.end(),
        () => socket.destroy(),
      );
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index !== -1) {
          this.#handle(session, buffer.slice(0, index).replace(/\r$/, ''));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
      });
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    this.port = (server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    for (const client of this.#wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => {
      if (this.#wss) this.#wss.close(() => resolve());
      else if (this.#server) this.#server.close(() => resolve());
      else resolve();
    });
  }

  /** Commands received (first token), for assertions such as "never SUB-PRESS". */
  get commands(): string[] {
    return this.received.map((line) => parseLine(line).command);
  }

  #newSession(send: (line: string) => void, end: () => void, destroy: () => void): Session {
    const session: Session = {
      send,
      end,
      destroy,
      deviceId: null,
      keysTotal: 32,
      keysPerRow: 8,
      bitmaps: null,
      bitmapFormat: null,
      page: 1,
      variable: 0,
      lockedNow: this.options.locked ?? false,
      held: new Set(),
    };
    this.sessions.push(session);
    const begin = (): void => {
      if (this.options.silent) return;
      send(
        `BEGIN CompanionVersion="5.1.3+1-test" ApiVersion="${this.options.apiVersion ?? '1.14.0'}"`,
      );
      send(
        `CAPS SUBSCRIPTIONS=${this.options.subscriptions ? 1 : 0} NONSQUARE=1 BITMAP_FORMATS="${this.options.bitmapFormats ?? 'rgb,png,webp'}" ROTARY_AMOUNT=1`,
      );
    };
    if (this.options.beginDelayMs) setTimeout(begin, this.options.beginDelayMs);
    else begin();
    return session;
  }

  /** What the key at `index` currently shows. */
  #view(session: Session, index: number): KeyView {
    const row = Math.floor(index / session.keysPerRow);
    const column = index % session.keysPerRow;
    const held = session.held.has(index);
    if (session.page === 1) {
      const red = session.variable === 42;
      if (row === 0 && column === 0)
        return { text: 'SET', color: red ? '#ff0000' : '#00ff00', pressed: held };
      if (row === 0 && column === 1)
        return { text: 'RESET', color: red ? '#ff0000' : '#0000ff', pressed: held };
      if (row === 0 && column === 3)
        return { text: 'FLICK', color: held ? '#ffffff' : '#808080', pressed: held };
      if (row === 1 && column === 0) return { text: 'UP', color: '#202020', pressed: held };
    } else if (row === 0 && column === 0) {
      return { text: 'P2', color: '#ffff00', pressed: held };
    }
    return { text: '', color: '#000000', pressed: held };
  }

  #keyState(session: Session, index: number, page = session.page): string {
    const view = this.#view(session, index);
    const row = Math.floor(index / session.keysPerRow);
    const column = index % session.keysPerRow;
    const isNav = page === 1 && row === 1 && column === 0;
    const bitmap =
      session.bitmaps === null
        ? ''
        : ` BITMAP="${
            session.bitmapFormat === 'png'
              ? `data:image/png;base64,${Buffer.from(`${view.color}${view.pressed ? 'P' : ''}`).toString('base64')}`
              : Buffer.from(`${view.color}${view.pressed ? 'P' : ''}`).toString('base64')
          }"`;
    return (
      `KEY-STATE DEVICEID="${session.deviceId}" KEY=${index} LOCATION="${page}/${row}/${column}" ` +
      `PRESSED=${view.pressed ? 1 : 0} TYPE="${isNav ? 'PAGEUP' : 'BUTTON'}"${bitmap} COLOR="${view.color}" ` +
      `TEXTCOLOR="#000000" TEXT="${b64(view.text)}" FONT_SIZE=${view.text === '' ? '"auto"' : '21.1'}`
    );
  }

  /** Deterministic "unordered" order like the measured 2,3,0,4,... */
  #flood(session: Session, only?: number[]): void {
    const indices = only ?? Array.from({ length: session.keysTotal }, (_, i) => i);
    const order = [...indices].sort((a, b) => ((a * 7) % 11) - ((b * 7) % 11) || a - b);
    const late = this.options.latePageKeyDelayMs;
    for (const index of order) {
      if (late !== undefined && session.page === 2 && index === session.keysTotal - 1) {
        const page = session.page;
        setTimeout(() => session.send(this.#keyState(session, index, page)), late);
      } else {
        session.send(this.#keyState(session, index));
      }
    }
  }

  #handle(session: Session, line: string): void {
    if (line === '') return;
    this.received.push(line);
    const parsed = parseLine(line);
    const params = parsed.params;
    const str = (name: string): string | undefined => {
      const value = params[name];
      return typeof value === 'string' ? value : undefined;
    };
    switch (parsed.command) {
      case 'PING':
        if (!this.options.ignorePing) session.send(`PONG ${line.slice(5)}`);
        return;
      case 'QUIT':
        session.end();
        return;
      case 'ADD-DEVICE': {
        const id = str('DEVICEID');
        if (this.options.ignoreAddDevice) return;
        if (this.options.rejectAddDevice !== undefined) {
          session.send(
            `ADD-DEVICE ERROR DEVICEID="${id}" MESSAGE="${this.options.rejectAddDevice}"`,
          );
          return;
        }
        session.deviceId = id ?? null;
        session.keysTotal = Number(str('KEYS_TOTAL') ?? 32);
        session.keysPerRow = Number(str('KEYS_PER_ROW') ?? 8);
        session.bitmaps = str('BITMAPS') ?? null;
        session.bitmapFormat = str('BITMAP_FORMAT') ?? null;
        session.send(`ADD-DEVICE OK DEVICEID="${id}"`);
        session.send(`BRIGHTNESS DEVICEID="${id}" VALUE=100`);
        if (session.lockedNow) {
          session.send(`LOCKED-STATE DEVICEID="${id}" LOCKED=1 CHARACTER_COUNT=0 ROTATION=0`);
        } else this.#flood(session);
        return;
      }
      case 'REMOVE-DEVICE': {
        const id = str('DEVICEID');
        if (id === session.deviceId) {
          session.send(`REMOVE-DEVICE OK DEVICEID="${id}"`);
          session.deviceId = null;
        } else session.send(`REMOVE-DEVICE ERROR DEVICEID="${id}" MESSAGE="Device not found"`);
        return;
      }
      case 'KEY-PRESS': {
        const id = str('DEVICEID');
        if (id !== session.deviceId || id === null) {
          session.send(`KEY-PRESS ERROR DEVICEID="${id}" MESSAGE="Device not found"`);
          return;
        }
        const key = Number(str('KEY'));
        const down = str('PRESSED') === '1';
        if (this.options.ignoreKeyPress) return;
        // OK comes first and for everything, as measured.
        session.send(`KEY-PRESS OK DEVICEID="${id}"`);
        if (session.lockedNow) return;
        const row = Math.floor(key / session.keysPerRow);
        const column = key % session.keysPerRow;
        if (session.page === 1 && row === 0 && column === 0) {
          if (down) {
            session.variable = 42;
            session.held.add(key);
            this.#flood(session, [0, 1]);
          } else {
            session.held.delete(key);
            this.#flood(session, [0]);
          }
        } else if (session.page === 1 && row === 0 && column === 3) {
          if (down) session.held.add(key);
          else session.held.delete(key);
          this.#flood(session, [key]);
        } else if (session.page === 1 && row === 1 && column === 0 && down) {
          session.page = 2;
          this.#flood(session);
        }
        return;
      }
      default:
        session.send(`ERROR MESSAGE="Unknown command: ${parsed.command}"`);
    }
  }
}
