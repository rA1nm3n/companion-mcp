import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { isJsonObject, type JsonObject, type JsonValue } from '../safety/json.js';
import { TransportError } from './errors.js';
import { assertSupportedVersion } from './version.js';

/**
 * Minimal tRPC-over-WebSocket client (no transformer), implemented from the tRPC 11 wire format as read in
 * `@trpc/server/adapters/ws` and measured against Companion 5.1.3:
 *
 *   request   {"id":<n>,"method":"query"|"mutation"|"subscription"|"subscription.stop","params":{"path","input"}}
 *   response  {"id":<n>,"result":{"type":"data","data":...}}   query/mutation result and subscription items
 *             {"id":<n>,"result":{"type":"started"|"stopped"}} subscription lifecycle
 *             {"id":<n>|null,"error":{"message","code","data":{"code","httpStatus","path"}}}
 *   keep-alive text frames "PING" (server) answered with "PONG" (client)
 *   {"id":null,"method":"reconnect"} server restart notice
 *
 * Companion keeps the pending import on the socket context, so all import steps must share one connection.
 */

export interface TrpcOptions {
  /** Timeout for connecting and for each ordinary call. Default 10000 ms. */
  timeoutMs?: number;
  /** Timeout for the whole import sequence per step. Default 60000 ms. */
  importTimeoutMs?: number;
  /** Accept Companion versions other than 5.1.x. Default false. */
  allowUnknownVersion?: boolean;
}

export interface CompanionVersion {
  appVersion: string;
  appBuild: string;
}

export interface ImportPageOptions {
  /** The export file (type `page`, or `full` together with `sourcePage`). Opaque JSON for this layer. */
  exportFile: JsonObject;
  /** Target page number (>= 1) or -1 to append a new page. */
  targetPage: number;
  /** Source page inside a `full` export. Default 1. */
  sourcePage?: number;
  /** Maps connection IDs in the file to existing connection IDs. Default: empty (Companion decides). */
  connectionMapping?: Record<string, string>;
}

export interface ImportPageResult {
  /** The connection remapping Companion reports after the import. */
  remapping: JsonValue;
  /** Raw `[error, clientObject]` tuple content of `prepareImport.complete` (clientObject only). */
  prepared: JsonValue;
}

export interface PageControl {
  row: number;
  column: number;
  controlId: string;
  /** Control config as reported by `controls.watchControl` (same shape as an export control). */
  config: JsonObject;
}

export interface PageReadback {
  pageNumber: number;
  name: string;
  /** `{ [row]: { [column]: control config } }`, same layout as `page.controls` in an export. */
  controls: JsonObject;
  list: PageControl[];
}

interface Pending {
  type: 'query' | 'mutation' | 'subscription';
  path: string;
  timer: NodeJS.Timeout;
  resolve: (value: JsonValue) => void;
  reject: (error: TransportError) => void;
  /** Subscriptions: first data item already delivered, waiting for `stopped`. */
  settled: boolean;
}

const UPLOAD_CHUNK_BYTES = 256 * 1024;
const IMPORT_FILE_NAME = 'companion-mcp-import.companionconfig';

export class CompanionTrpc {
  #ws: WebSocket | undefined;
  #httpBase = '';
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #timeoutMs = 10_000;
  #importTimeoutMs = 60_000;
  #allowUnknownVersion = false;
  #importRunning = false;
  #everConnected = false;
  #version: CompanionVersion | undefined;
  #closeReason: string | undefined;

  /** Connects, then reads the version and applies the version guard. One connection per instance, no auto reconnect. */
  async connect(url: string, options: TrpcOptions = {}): Promise<void> {
    if (this.#importRunning) {
      throw new TransportError(
        'RECONNECT_FORBIDDEN',
        'Cannot (re)connect while an import is running',
      );
    }
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      throw new TransportError('RECONNECT_FORBIDDEN', 'Already connected; close() first');
    }
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#importTimeoutMs = options.importTimeoutMs ?? 60_000;
    this.#allowUnknownVersion = options.allowUnknownVersion ?? false;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (cause) {
      throw new TransportError('INVALID_ARGUMENT', `Invalid URL: ${url}`, { cause });
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      throw new TransportError('INVALID_ARGUMENT', `Unsupported URL scheme: ${parsed.protocol}`);
    }
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
    this.#httpBase = `${secure ? 'https' : 'http'}://${parsed.host}`;
    const wsUrl = `${secure ? 'wss' : 'ws'}://${parsed.host}/trpc`;

    await this.#open(wsUrl);
    try {
      const version = await this.getVersion();
      assertSupportedVersion(version.appVersion, this.#allowUnknownVersion);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #open(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // No Origin header is sent: Companion allows origin-less non-browser clients.
      const ws = new WebSocket(wsUrl, { handshakeTimeout: this.#timeoutMs });
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.#ws = ws;
        this.#everConnected = true;
        this.#closeReason = undefined;
        resolve();
      });
      ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
      ws.on('error', (cause) => {
        if (!opened) {
          reject(
            new TransportError('CONNECT_FAILED', `Cannot connect to ${wsUrl}: ${cause.message}`, {
              cause,
            }),
          );
        }
      });
      ws.on('close', (code, reason) => {
        this.#closeReason = `WebSocket closed (code ${code}${reason.length > 0 ? `, ${reason.toString()}` : ''})`;
        if (!opened) {
          reject(
            new TransportError('CONNECT_FAILED', `Connection to ${wsUrl} closed before it opened`),
          );
          return;
        }
        if (this.#ws === ws) this.#ws = undefined;
        this.#failAll(new TransportError('CLOSED', this.#closeReason));
      });
    });
  }

  get connected(): boolean {
    return this.#ws !== undefined && this.#ws.readyState === WebSocket.OPEN;
  }

  /** Cached version from connect(); use getVersion() for a fresh read. */
  get version(): CompanionVersion | undefined {
    return this.#version;
  }

  close(): void {
    const ws = this.#ws;
    this.#ws = undefined;
    this.#failAll(new TransportError('CLOSED', 'Connection closed by client'));
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
  }

  // ---- wire level --------------------------------------------------------------------------------------------

  #onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) return;
    const text = data.toString();
    if (text === 'PING') {
      this.#ws?.send('PONG');
      return;
    }
    if (text === 'PONG') return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.#failAll(new TransportError('PROTOCOL', 'Received a non-JSON message from Companion'));
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    for (const entry of messages) this.#onJsonMessage(entry);
  }

  #onJsonMessage(message: unknown): void {
    if (!isJsonObject(message as JsonValue)) return;
    const msg = message as JsonObject;
    const id = msg['id'];
    if (msg['method'] === 'reconnect') {
      this.#failAll(
        new TransportError('CLOSED', 'Companion announced a restart (reconnect notice)'),
      );
      return;
    }
    const error = msg['error'];
    if (id === null || id === undefined) {
      if (error !== undefined) this.#failAll(this.#parseError(error, undefined));
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (!pending) return;

    if (error !== undefined) {
      this.#settle(id, pending);
      pending.reject(this.#parseError(error, pending.path));
      return;
    }
    const result = msg['result'];
    if (!isJsonObject(result as JsonValue)) {
      this.#settle(id, pending);
      pending.reject(
        new TransportError('PROTOCOL', `Malformed response for ${pending.path}`, {
          path: pending.path,
        }),
      );
      return;
    }
    const typed = result as JsonObject;
    switch (typed['type']) {
      case 'data':
        if (pending.type === 'subscription') {
          if (pending.settled) return;
          pending.settled = true;
          clearTimeout(pending.timer);
          // Keep the entry until the server confirms `stopped`, then ignore late items.
          this.#send({ id, method: 'subscription.stop' });
          pending.resolve(typed['data'] ?? null);
        } else {
          this.#settle(id, pending);
          pending.resolve(typed['data'] ?? null);
        }
        return;
      case 'started':
        return;
      case 'stopped':
        this.#pending.delete(id);
        if (!pending.settled) {
          clearTimeout(pending.timer);
          pending.reject(
            new TransportError('PROTOCOL', `Subscription ${pending.path} stopped without data`, {
              path: pending.path,
            }),
          );
        }
        return;
      default:
        this.#settle(id, pending);
        pending.reject(
          new TransportError('PROTOCOL', `Unknown result type for ${pending.path}`, {
            path: pending.path,
          }),
        );
    }
  }

  #parseError(raw: unknown, path: string | undefined): TransportError {
    let message = 'Remote error';
    let remoteCode: string | undefined;
    let errorPath = path;
    if (isJsonObject(raw as JsonValue)) {
      const err = raw as JsonObject;
      if (typeof err['message'] === 'string') message = err['message'];
      const data = err['data'];
      if (isJsonObject(data as JsonValue)) {
        const d = data as JsonObject;
        if (typeof d['code'] === 'string') remoteCode = d['code'];
        if (typeof d['path'] === 'string') errorPath = d['path'];
      }
    }
    return new TransportError('REMOTE_ERROR', errorPath ? `${errorPath}: ${message}` : message, {
      ...(errorPath === undefined ? {} : { path: errorPath }),
      ...(remoteCode === undefined ? {} : { remoteCode }),
    });
  }

  #settle(id: number, pending: Pending): void {
    clearTimeout(pending.timer);
    this.#pending.delete(id);
  }

  #failAll(error: TransportError): void {
    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      if (!pending.settled) pending.reject(error);
    }
  }

  #send(payload: Record<string, unknown>): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new TransportError('NOT_CONNECTED', this.#closeReason ?? 'Not connected');
    }
    ws.send(JSON.stringify(payload));
  }

  #call(
    type: Pending['type'],
    path: string,
    input: JsonValue | undefined,
    timeoutMs: number = this.#timeoutMs,
  ): Promise<JsonValue> {
    return new Promise<JsonValue>((resolve, reject) => {
      if (!this.connected) {
        reject(
          new TransportError(
            this.#everConnected ? 'CLOSED' : 'NOT_CONNECTED',
            this.#closeReason ?? 'Not connected',
            { path },
          ),
        );
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        const entry = this.#pending.get(id);
        if (!entry) return;
        this.#pending.delete(id);
        if (type === 'subscription') {
          try {
            this.#send({ id, method: 'subscription.stop' });
          } catch {
            // connection already gone
          }
        }
        reject(new TransportError('TIMEOUT', `Timeout after ${timeoutMs} ms: ${path}`, { path }));
      }, timeoutMs);
      this.#pending.set(id, { type, path, timer, resolve, reject, settled: false });
      try {
        this.#send({ id, method: type, params: { path, input: input ?? null } });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(
          error instanceof TransportError
            ? error
            : new TransportError('PROTOCOL', String(error), { path }),
        );
      }
    });
  }

  query(path: string, input?: JsonValue, timeoutMs?: number): Promise<JsonValue> {
    return this.#call('query', path, input, timeoutMs);
  }

  mutation(path: string, input?: JsonValue, timeoutMs?: number): Promise<JsonValue> {
    return this.#call('mutation', path, input, timeoutMs);
  }

  /** Reads the first item of a subscription and unsubscribes. */
  firstOfSubscription(path: string, input?: JsonValue, timeoutMs?: number): Promise<JsonValue> {
    return this.#call('subscription', path, input, timeoutMs);
  }

  // ---- high level --------------------------------------------------------------------------------------------

  /** Companion version via the tRPC query `appInfo.version` (measured on 5.1.3). */
  async getVersion(): Promise<CompanionVersion> {
    const raw = await this.query('appInfo.version', { all: true });
    if (!isJsonObject(raw) || typeof raw['appVersion'] !== 'string') {
      throw new TransportError('PROTOCOL', 'appInfo.version returned an unexpected shape', {
        path: 'appInfo.version',
      });
    }
    const version: CompanionVersion = {
      appVersion: raw['appVersion'],
      appBuild: typeof raw['appBuild'] === 'string' ? raw['appBuild'] : '',
    };
    this.#version = version;
    return version;
  }

  async #httpGetJson(path: string): Promise<JsonObject> {
    if (this.#httpBase === '') throw new TransportError('NOT_CONNECTED', 'Not connected');
    let response: Response;
    try {
      response = await fetch(`${this.#httpBase}${path}`, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      throw new TransportError(
        timedOut ? 'TIMEOUT' : 'HTTP_ERROR',
        timedOut ? `Timeout after ${this.#timeoutMs} ms: ${path}` : `HTTP request failed: ${path}`,
        { path, cause },
      );
    }
    if (!response.ok) {
      throw new TransportError('HTTP_ERROR', `HTTP ${response.status} for ${path}`, {
        path,
        status: response.status,
      });
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new TransportError('PROTOCOL', `Response of ${path} is not JSON`, { path, cause });
    }
    if (!isJsonObject(json as JsonValue)) {
      throw new TransportError('PROTOCOL', `Response of ${path} is not a JSON object`, { path });
    }
    return json as JsonObject;
  }

  /** Full export (`GET /int/export/full?format=json`, loopback only on the Companion side). */
  exportFull(): Promise<JsonObject> {
    return this.#httpGetJson('/int/export/full?format=json');
  }

  /** Single page export (`GET /int/export/page/<n>?format=json`). */
  async exportPage(pageNumber: number): Promise<JsonObject> {
    assertPageNumber(pageNumber);
    return this.#httpGetJson(`/int/export/page/${pageNumber}?format=json`);
  }

  /**
   * Measured sequence on ONE connection: prepareImport.start, uploadChunk, complete, importSinglePage.
   * The socket is never re-opened during an import: if it drops, the outcome is unknown and the caller must
   * read back (getPage / exportPage) before doing anything else.
   * Note: Companion allows one upload session at a time; a failed session is cancelled best-effort.
   */
  async importPage(options: ImportPageOptions): Promise<ImportPageResult> {
    const { exportFile, targetPage } = options;
    if (!Number.isInteger(targetPage) || (targetPage < 1 && targetPage !== -1)) {
      throw new TransportError(
        'INVALID_ARGUMENT',
        'targetPage must be an integer >= 1, or -1 to append',
      );
    }
    const sourcePage = options.sourcePage ?? 1;
    if (!Number.isInteger(sourcePage) || sourcePage < 1) {
      throw new TransportError('INVALID_ARGUMENT', 'sourcePage must be an integer >= 1');
    }
    if (this.#importRunning) {
      throw new TransportError(
        'IMPORT_IN_PROGRESS',
        'Another import is running on this connection',
      );
    }
    if (!this.connected) {
      throw new TransportError('NOT_CONNECTED', this.#closeReason ?? 'Not connected');
    }

    const buffer = Buffer.from(JSON.stringify(exportFile), 'utf8');
    const t = this.#importTimeoutMs;
    this.#importRunning = true;
    let sessionId: string | undefined;
    let completed = false;
    try {
      const started = await this.mutation(
        'importExport.prepareImport.start',
        { name: IMPORT_FILE_NAME, size: buffer.length },
        t,
      );
      if (typeof started !== 'string') {
        throw new TransportError('PROTOCOL', 'prepareImport.start did not return a session id', {
          path: 'importExport.prepareImport.start',
        });
      }
      sessionId = started;
      for (let offset = 0; offset < buffer.length; offset += UPLOAD_CHUNK_BYTES) {
        const chunk = buffer.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
        await this.mutation(
          'importExport.prepareImport.uploadChunk',
          { sessionId, offset, data: chunk.toString('base64') },
          t,
        );
      }
      const checksum = createHash('sha1').update(buffer).digest('hex');
      const prepared = await this.mutation(
        'importExport.prepareImport.complete',
        { sessionId, expectedChecksum: checksum, userData: null },
        t,
      );
      completed = true;
      if (!Array.isArray(prepared) || prepared.length < 2) {
        throw new TransportError(
          'PROTOCOL',
          'prepareImport.complete returned an unexpected shape',
          {
            path: 'importExport.prepareImport.complete',
          },
        );
      }
      const [prepareError, clientObject] = prepared;
      if (prepareError !== null && prepareError !== undefined) {
        throw new TransportError(
          'IMPORT_FAILED',
          `Companion rejected the import file: ${String(prepareError)}`,
          {
            path: 'importExport.prepareImport.complete',
          },
        );
      }
      const remapping = await this.mutation(
        'importExport.importSinglePage',
        { targetPage, sourcePage, connectionIdRemapping: options.connectionMapping ?? {} },
        t,
      );
      return { remapping, prepared: clientObject ?? null };
    } catch (error) {
      const lost =
        error instanceof TransportError &&
        (error.code === 'CLOSED' || error.code === 'NOT_CONNECTED');
      if (lost) {
        throw new TransportError(
          'IMPORT_CONNECTION_LOST',
          'Connection lost during import; no reconnect is attempted. The outcome is unknown: read back before retrying.',
          { cause: error },
        );
      }
      await this.#cleanupAfterFailure(sessionId, completed);
      throw error;
    } finally {
      this.#importRunning = false;
    }
  }

  async #cleanupAfterFailure(sessionId: string | undefined, completed: boolean): Promise<void> {
    if (!this.connected) return;
    try {
      if (sessionId !== undefined && !completed) {
        await this.mutation('importExport.prepareImport.cancel', { sessionId }, 5_000);
      }
      if (completed) await this.mutation('importExport.abort', undefined, 5_000);
    } catch {
      // best effort only
    }
  }

  /**
   * Read-back as in the measurement scripts: `pages.watch` for the layout, then `controls.watchControl` for
   * every control of the page.
   */
  async getPage(pageNumber: number): Promise<PageReadback> {
    assertPageNumber(pageNumber);
    const pages = await this.firstOfSubscription('pages.watch');
    if (!isJsonObject(pages) || !Array.isArray(pages['order']) || !isJsonObject(pages['pages'])) {
      throw new TransportError('PROTOCOL', 'pages.watch returned an unexpected shape', {
        path: 'pages.watch',
      });
    }
    const pageId = pages['order'][pageNumber - 1];
    if (typeof pageId !== 'string') {
      throw new TransportError(
        'INVALID_ARGUMENT',
        `Page ${pageNumber} does not exist (${pages['order'].length} pages)`,
      );
    }
    const page = pages['pages'][pageId];
    if (!isJsonObject(page) || typeof page['name'] !== 'string') {
      throw new TransportError('PROTOCOL', 'pages.watch page entry malformed', {
        path: 'pages.watch',
      });
    }
    const layout = isJsonObject(page['controls']) ? page['controls'] : {};
    const controls: JsonObject = {};
    const list: PageControl[] = [];
    for (const [rowKey, columns] of Object.entries(layout)) {
      if (!isJsonObject(columns)) continue;
      for (const [columnKey, controlId] of Object.entries(columns)) {
        if (typeof controlId !== 'string') continue;
        const control = await this.firstOfSubscription('controls.watchControl', { controlId });
        if (!isJsonObject(control) || !isJsonObject(control['config'])) {
          throw new TransportError(
            'PROTOCOL',
            `controls.watchControl for ${rowKey}/${columnKey} malformed`,
            {
              path: 'controls.watchControl',
            },
          );
        }
        const config = control['config'];
        const row = (controls[rowKey] ??= {}) as JsonObject;
        row[columnKey] = config;
        list.push({ row: Number(rowKey), column: Number(columnKey), controlId, config });
      }
    }
    return { pageNumber, name: page['name'], controls, list };
  }
}

function assertPageNumber(pageNumber: number): void {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new TransportError('INVALID_ARGUMENT', 'pageNumber must be an integer >= 1');
  }
}
