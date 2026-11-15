import { assertHostAllowed, assertPressAllowed, type SafetyConfig } from '../safety/index.js';
import { VirtualDeck } from './deck.js';
import { SatelliteError } from './errors.js';
import {
  assertSafeDeviceId,
  compareApiVersions,
  parseServerLine,
  serializeCommand,
  type BitmapFormat,
  type CapsMessage,
  type ClientCommand,
  type KeyLocation,
  type ResponseMessage,
  type ServerMessage,
} from './protocol.js';
import {
  DEFAULT_TCP_PORT,
  DEFAULT_WS_PORT,
  LineSplitter,
  TcpTransport,
  WsTransport,
  type LineTransport,
} from './transport.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'ready' | 'closing';

export interface SatelliteClientOptions {
  /** Host allow-list and press gate. Required: there is no unchecked client. */
  safety: SafetyConfig;
  /** `tcp` (port 16622, default) or `ws` (port 16623). */
  transport?: 'tcp' | 'ws';
  /** PING interval. Companion drops silent clients after 5 s and never pings itself. Default 2000 ms, max 4999. */
  pingIntervalMs?: number;
  /** Unanswered PING older than this ends the connection with `PONG_TIMEOUT`. Default 5000 ms. */
  pongTimeoutMs?: number;
  /** Lowest accepted ApiVersion. Default `1.10.0` (first version with `LOCATION`). Major must be 1. */
  minApiVersion?: string;
}

export interface ConnectOptions {
  /** Budget for TCP/WebSocket connect plus BEGIN/CAPS. Default 5000 ms. */
  timeoutMs?: number;
}

export interface HandshakeInfo {
  companionVersion: string | null;
  apiVersion: string;
  caps: CapsMessage | null;
  /** `CAPS SUBSCRIPTIONS=1`: subscriptions are enabled on the server and bypass the PIN. Never used here. */
  subscriptionsEnabled: boolean;
  warnings: string[];
}

export interface AddDeviceOptions {
  /** `[A-Za-z0-9_-]{1,64}`. Use a fixed id: every new id creates a permanent surface entry in Companion. */
  deviceId?: string;
  productName?: string;
  /** Default 32. */
  keysTotal?: number;
  /** Default 8 (8x4 deck). */
  keysPerRow?: number;
  /** Bitmap edge length in pixels. Omitted (default): text and colour only, no bitmaps. */
  bitmapSize?: number;
  /** Falls back to rgb when the server does not list the format in `CAPS BITMAP_FORMATS`. */
  bitmapFormat?: BitmapFormat;
  /** Default 3000 ms. */
  timeoutMs?: number;
}

export const DEFAULT_DEVICE_ID = 'mcp-virtual-deck';
const MIN_API_VERSION = '1.10.0';
const BITMAP_FORMAT_MIN_API = '1.12.0';

type Listener<T> = (value: T) => void;

interface Pending {
  resolve: (message: ResponseMessage) => void;
  reject: (error: SatelliteError) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client for the Companion Satellite API (virtual surface). One instance, one connection, no automatic
 * reconnect: after `disconnected` the caller must call `connect` again and re-add its devices.
 *
 * It never produces subscription commands, variable writes or page changes (see `ClientCommand`).
 */
export class SatelliteClient {
  readonly safety: SafetyConfig;
  #options: Required<Pick<SatelliteClientOptions, 'pingIntervalMs' | 'pongTimeoutMs'>> &
    SatelliteClientOptions;
  #state: ConnectionState = 'disconnected';
  #transport: LineTransport | undefined;
  #splitter = new LineSplitter();
  #host: string | null = null;
  #port: number | null = null;
  #info: HandshakeInfo | null = null;
  #begin: { companionVersion: string | null; apiVersion: string | null } | null = null;
  #caps: CapsMessage | null = null;
  #handshake: { onProgress: () => void; reject: (error: SatelliteError) => void } | null = null;
  #decks = new Map<string, VirtualDeck>();
  #pending = new Map<string, Pending[]>();
  #pingTimer: NodeJS.Timeout | undefined;
  #pingOutstandingSince: number | null = null;
  #pingCounter = 0;
  #stateListeners = new Set<Listener<ConnectionState>>();
  #errorListeners = new Set<Listener<SatelliteError>>();
  #unknownListeners = new Set<Listener<ServerMessage>>();
  #unsolicitedListeners = new Set<Listener<ResponseMessage>>();

  constructor(options: SatelliteClientOptions) {
    const pingIntervalMs = options.pingIntervalMs ?? 2000;
    const pongTimeoutMs = options.pongTimeoutMs ?? 5000;
    if (!Number.isInteger(pingIntervalMs) || pingIntervalMs < 10 || pingIntervalMs >= 5000) {
      throw new SatelliteError(
        'INVALID_ARGUMENT',
        'pingIntervalMs must be an integer in 10..4999 (Companion drops clients silent for 5 s)',
      );
    }
    if (!Number.isInteger(pongTimeoutMs) || pongTimeoutMs < 10) {
      throw new SatelliteError('INVALID_ARGUMENT', 'pongTimeoutMs must be an integer >= 10');
    }
    this.safety = options.safety;
    this.#options = { ...options, pingIntervalMs, pongTimeoutMs };
  }

  get state(): ConnectionState {
    return this.#state;
  }
  get host(): string | null {
    return this.#host;
  }
  get port(): number | null {
    return this.#port;
  }
  get info(): HandshakeInfo | null {
    return this.#info;
  }
  get devices(): VirtualDeck[] {
    return [...this.#decks.values()];
  }

  onState(listener: Listener<ConnectionState>): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }
  /** Connection-level failures after `ready` (lost connection, PONG timeout, oversized line). */
  onError(listener: Listener<SatelliteError>): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }
  /** Lines this client does not understand (newer servers, web-doc-only commands). Tolerated, never fatal. */
  onUnknown(listener: Listener<ServerMessage>): () => void {
    this.#unknownListeners.add(listener);
    return () => this.#unknownListeners.delete(listener);
  }
  /** Answers nobody waits for, e.g. `ADD-DEVICE ERROR Device exists elsewhere` meant for the first owner. */
  onUnsolicited(listener: Listener<ResponseMessage>): () => void {
    this.#unsolicitedListeners.add(listener);
    return () => this.#unsolicitedListeners.delete(listener);
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of [...this.#stateListeners]) listener(state);
  }

  /**
   * Connects and negotiates. The host must pass `assertHostAllowed` (throws `SafetyError`). The Satellite port
   * has no authentication, so only an explicitly allowed host is ever contacted.
   */
  async connect(host: string, port?: number, options: ConnectOptions = {}): Promise<HandshakeInfo> {
    if (this.#state !== 'disconnected') {
      throw new SatelliteError('INVALID_STATE', `Cannot connect while ${this.#state}`);
    }
    assertHostAllowed(this.safety, host);
    const kind = this.#options.transport ?? 'tcp';
    const effectivePort = port ?? (kind === 'ws' ? DEFAULT_WS_PORT : DEFAULT_TCP_PORT);
    if (!Number.isInteger(effectivePort) || effectivePort < 1 || effectivePort > 65535) {
      throw new SatelliteError('INVALID_ARGUMENT', 'port must be an integer in 1..65535');
    }
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new SatelliteError('INVALID_ARGUMENT', 'timeoutMs must be > 0');
    }

    const transport: LineTransport = kind === 'ws' ? new WsTransport() : new TcpTransport();
    this.#transport = transport;
    this.#splitter = new LineSplitter();
    this.#begin = null;
    this.#caps = null;
    this.#info = null;
    this.#host = host;
    this.#port = effectivePort;
    transport.onData = (text) => this.#onText(transport, text);
    transport.onClose = (error) => this.#onTransportClose(transport, error);
    this.#setState('connecting');

    const started = Date.now();
    try {
      await transport.connect(host, effectivePort, timeoutMs);
      const info = await this.#awaitHandshake(Math.max(1, timeoutMs - (Date.now() - started)));
      this.#info = info;
    } catch (error) {
      this.#teardown(transport);
      this.#setState('disconnected');
      throw error;
    }
    this.#setState('ready');
    this.#startPing();
    return this.#info;
  }

  #awaitHandshake(timeoutMs: number): Promise<HandshakeInfo> {
    return new Promise<HandshakeInfo>((resolve, reject) => {
      if (this.#transport === undefined) {
        reject(new SatelliteError('CONNECTION_LOST', 'Connection closed during the handshake'));
        return;
      }
      let graceTimer: NodeJS.Timeout | undefined;
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        this.#handshake = null;
        fn();
      };
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new SatelliteError(
                'HANDSHAKE_TIMEOUT',
                `No BEGIN from the server within ${timeoutMs} ms`,
              ),
            ),
          ),
        timeoutMs,
      );
      const finish = (): void => {
        try {
          resolve(this.#negotiate());
        } catch (error) {
          reject(error as SatelliteError);
        }
      };
      this.#handshake = {
        reject: (error) => settle(() => reject(error)),
        onProgress: () => {
          if (this.#begin === null) return;
          if (this.#caps !== null) settle(finish);
          else if (!graceTimer) {
            // CAPS follows BEGIN immediately in 1.14; tolerate servers that omit it.
            graceTimer = setTimeout(() => settle(finish), 300);
          }
        },
      };
      // BEGIN and CAPS may already have arrived together with the connection.
      this.#handshake.onProgress();
    });
  }

  #negotiate(): HandshakeInfo {
    const begin = this.#begin;
    const apiVersion = begin?.apiVersion ?? null;
    if (apiVersion === null) {
      throw new SatelliteError('UNSUPPORTED_VERSION', 'BEGIN did not announce an ApiVersion');
    }
    const minimum = this.#options.minApiVersion ?? MIN_API_VERSION;
    const against = compareApiVersions(apiVersion, minimum);
    const major = /^(\d+)\./.exec(apiVersion)?.[1];
    if (against === null || major !== '1') {
      throw new SatelliteError(
        'UNSUPPORTED_VERSION',
        `Unsupported Satellite ApiVersion "${apiVersion}" (this client speaks 1.x)`,
      );
    }
    if (against < 0) {
      throw new SatelliteError(
        'UNSUPPORTED_VERSION',
        `Satellite ApiVersion ${apiVersion} is older than the required ${minimum}`,
      );
    }
    const warnings: string[] = [];
    const subscriptionsEnabled = this.#caps?.subscriptions ?? false;
    if (subscriptionsEnabled) {
      warnings.push(
        'Satellite subscriptions are enabled on this Companion (CAPS SUBSCRIPTIONS=1). They bypass the PIN lock; this client never uses them. Consider disabling them.',
      );
    }
    if ((compareApiVersions(apiVersion, '1.14.0') ?? 0) > 0) {
      warnings.push(
        `ApiVersion ${apiVersion} is newer than the measured 1.14.0; unknown commands are tolerated.`,
      );
    }
    return {
      companionVersion: begin?.companionVersion ?? null,
      apiVersion,
      caps: this.#caps,
      subscriptionsEnabled,
      warnings,
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Incoming data

  #onText(transport: LineTransport, text: string): void {
    if (transport !== this.#transport) return;
    let lines: string[];
    try {
      lines = this.#splitter.push(text);
    } catch (error) {
      this.#fail(transport, error as SatelliteError);
      return;
    }
    for (const line of lines) {
      if (line === '') continue;
      this.#onMessage(parseServerLine(line));
    }
  }

  #onMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'begin':
        this.#begin = {
          companionVersion: message.companionVersion,
          apiVersion: message.apiVersion,
        };
        this.#handshake?.onProgress();
        return;
      case 'caps':
        this.#caps = message;
        this.#handshake?.onProgress();
        return;
      case 'pong':
        this.#pingOutstandingSince = null;
        return;
      case 'response':
        this.#onResponse(message);
        return;
      case 'key-state':
      case 'brightness':
      case 'locked-state':
      case 'keys-clear': {
        const deck = this.#decks.get(message.deviceId);
        if (deck) deck.apply(message);
        return;
      }
      case 'error':
      case 'unknown':
        for (const listener of [...this.#unknownListeners]) listener(message);
        return;
    }
  }

  #onResponse(message: ResponseMessage): void {
    const key = `${message.command}|${message.deviceId ?? ''}`;
    const queue = this.#pending.get(key);
    const pending = queue?.shift();
    if (queue && queue.length === 0) this.#pending.delete(key);
    if (!pending) {
      for (const listener of [...this.#unsolicitedListeners]) listener(message);
      return;
    }
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message);
    else {
      pending.reject(
        new SatelliteError(
          'COMMAND_REJECTED',
          `${message.command} rejected by Companion: ${message.message ?? 'no message'}`,
        ),
      );
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Sending

  #write(command: ClientCommand): void {
    const transport = this.#transport;
    if (!transport || (this.#state !== 'ready' && this.#state !== 'closing')) {
      throw new SatelliteError('INVALID_STATE', `Not connected (state: ${this.#state})`);
    }
    transport.send(`${serializeCommand(command)}\n`);
  }

  /** Sends a command and waits for its answer. At most one answer is matched per (command, DEVICEID), FIFO. */
  #request(
    command: ClientCommand & { deviceId: string },
    answerCommand: string,
    timeoutMs: number,
    timeoutHint = '',
  ): Promise<ResponseMessage> {
    return new Promise<ResponseMessage>((resolve, reject) => {
      const key = `${answerCommand}|${command.deviceId}`;
      const entry: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const queue = this.#pending.get(key);
          const index = queue ? queue.indexOf(entry) : -1;
          if (queue && index !== -1) queue.splice(index, 1);
          if (queue && queue.length === 0) this.#pending.delete(key);
          reject(
            new SatelliteError(
              'REQUEST_TIMEOUT',
              `No answer to ${answerCommand} within ${timeoutMs} ms${timeoutHint}`,
            ),
          );
        }, timeoutMs),
      };
      const queue = this.#pending.get(key) ?? [];
      queue.push(entry);
      this.#pending.set(key, queue);
      try {
        this.#write(command);
      } catch (error) {
        clearTimeout(entry.timer);
        queue.splice(queue.indexOf(entry), 1);
        if (queue.length === 0) this.#pending.delete(key);
        reject(error as SatelliteError);
      }
    });
  }

  /**
   * Registers a virtual deck (default 8x4 = 32 keys, text and colour only). Companion creates a permanent
   * surface entry for a new DEVICEID. If the id is connected elsewhere, the error goes to the other owner and
   * this call times out.
   */
  async addDevice(options: AddDeviceOptions = {}): Promise<VirtualDeck> {
    if (this.#state !== 'ready') {
      throw new SatelliteError('INVALID_STATE', `Cannot add a device while ${this.#state}`);
    }
    const deviceId = options.deviceId ?? DEFAULT_DEVICE_ID;
    assertSafeDeviceId(deviceId);
    if (this.#decks.has(deviceId)) {
      throw new SatelliteError('INVALID_STATE', `Device "${deviceId}" is already added`);
    }
    const keysTotal = options.keysTotal ?? 32;
    const keysPerRow = options.keysPerRow ?? 8;
    const bitmapSize = options.bitmapSize ?? null;

    let bitmapFormat: BitmapFormat | null = null;
    if (bitmapSize !== null) {
      bitmapFormat = 'rgb';
      const wanted = options.bitmapFormat ?? 'rgb';
      const info = this.#info;
      const supported =
        info !== null &&
        (compareApiVersions(info.apiVersion, BITMAP_FORMAT_MIN_API) ?? -1) >= 0 &&
        info.caps !== null &&
        info.caps.bitmapFormats.includes(wanted);
      if (wanted !== 'rgb' && supported) bitmapFormat = wanted;
    }

    const command: ClientCommand & { deviceId: string } = {
      type: 'add-device',
      deviceId,
      productName: options.productName ?? 'Companion MCP virtual deck',
      keysTotal,
      keysPerRow,
      colors: 'hex',
      text: true,
      textStyle: true,
      ...(bitmapSize !== null ? { bitmapSize } : {}),
      ...(bitmapFormat !== null && bitmapFormat !== 'rgb' ? { bitmapFormat } : {}),
    };
    serializeCommand(command); // validate before registering anything

    const deck = new VirtualDeck({ deviceId, keysTotal, keysPerRow, bitmapSize, bitmapFormat });
    // Registered before sending so no early KEY-STATE can be lost.
    this.#decks.set(deviceId, deck);
    try {
      await this.#request(
        command,
        'ADD-DEVICE',
        options.timeoutMs ?? 3000,
        ' (a device with the same DEVICEID may be connected elsewhere: Companion then answers the other owner)',
      );
    } catch (error) {
      this.#decks.delete(deviceId);
      deck.markDisconnected(
        error instanceof SatelliteError
          ? error
          : new SatelliteError('CONNECTION_LOST', 'add failed'),
      );
      throw error;
    }
    return deck;
  }

  async removeDevice(deviceId: string, timeoutMs = 3000): Promise<void> {
    const deck = this.#decks.get(deviceId);
    if (!deck) throw new SatelliteError('DEVICE_UNKNOWN', `Device "${deviceId}" is not added`);
    try {
      await this.#request({ type: 'remove-device', deviceId }, 'REMOVE-DEVICE', timeoutMs);
    } finally {
      this.#decks.delete(deviceId);
      deck.markDisconnected(
        new SatelliteError('DEVICE_UNKNOWN', `Device "${deviceId}" was removed`),
      );
    }
  }

  /**
   * Low-level KEY-PRESS. Pressing (`pressed: true`) goes through `assertPressAllowed` (write gate, host
   * allow-list, press allow-list) for the given Companion location; releasing is never blocked, so a release can
   * always follow. Returns after the server's `OK`, which is NOT proof that anything happened (measured: `OK` for
   * empty keys, locked surfaces and ignored page changes). Use `pressVerified` for read-before-press and render
   * verification.
   */
  async keyPress(
    deviceId: string,
    key: number,
    pressed: boolean,
    location: KeyLocation,
    timeoutMs = 1000,
  ): Promise<{ ackMs: number }> {
    if (!this.#decks.has(deviceId)) {
      throw new SatelliteError('DEVICE_UNKNOWN', `Device "${deviceId}" is not added`);
    }
    if (pressed) {
      if (this.#host === null) throw new SatelliteError('INVALID_STATE', 'Not connected');
      assertPressAllowed(this.safety, this.#host, location);
    }
    const sent = Date.now();
    await this.#request({ type: 'key-press', deviceId, key, pressed }, 'KEY-PRESS', timeoutMs);
    return { ackMs: Date.now() - sent };
  }

  // -------------------------------------------------------------------------------------------------------
  // Keepalive, failure, close

  #startPing(): void {
    this.#stopPing();
    this.#pingOutstandingSince = null;
    const transport = this.#transport;
    this.#pingTimer = setInterval(() => {
      if (this.#state !== 'ready' || !transport) return;
      const now = Date.now();
      if (
        this.#pingOutstandingSince !== null &&
        now - this.#pingOutstandingSince > this.#options.pongTimeoutMs
      ) {
        this.#fail(
          transport,
          new SatelliteError(
            'PONG_TIMEOUT',
            `No PONG within ${this.#options.pongTimeoutMs} ms; connection considered dead`,
          ),
        );
        return;
      }
      try {
        this.#pingCounter = (this.#pingCounter + 1) % 1_000_000;
        this.#write({ type: 'ping', payload: `k${this.#pingCounter}` });
        this.#pingOutstandingSince ??= now;
      } catch (error) {
        this.#fail(transport, error as SatelliteError);
      }
    }, this.#options.pingIntervalMs);
  }

  #stopPing(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
  }

  #rejectAllPending(error: SatelliteError): void {
    for (const queue of this.#pending.values()) {
      for (const entry of queue) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
    }
    this.#pending.clear();
  }

  #teardown(transport: LineTransport): void {
    this.#stopPing();
    this.#handshake = null;
    if (this.#transport === transport) this.#transport = undefined;
    transport.destroy();
  }

  #onTransportClose(transport: LineTransport, error?: Error): void {
    if (transport !== this.#transport) return;
    if (this.#state === 'closing') return; // handled by close()
    const reason = new SatelliteError(
      'CONNECTION_LOST',
      `Connection to Companion lost${error ? `: ${error.message}` : ''}`,
      error ? { cause: error } : undefined,
    );
    this.#fail(transport, reason);
  }

  /** Connection failure after or during connect. No reconnect: state becomes `disconnected`. */
  #fail(transport: LineTransport, error: SatelliteError): void {
    if (transport !== this.#transport) return;
    const wasHandshake = this.#handshake;
    const wasReady = this.#state === 'ready';
    this.#teardown(transport);
    this.#rejectAllPending(error);
    for (const deck of this.#decks.values()) deck.markDisconnected(error);
    this.#decks.clear();
    wasHandshake?.reject(error);
    if (this.#state !== 'connecting') this.#setState('disconnected');
    if (wasReady) for (const listener of [...this.#errorListeners]) listener(error);
  }

  /**
   * Clean shutdown: REMOVE-DEVICE for every device (best effort), QUIT, then close. Idempotent, with a hard
   * upper bound of about `timeoutMs` for the whole sequence.
   */
  async close(timeoutMs = 2000): Promise<void> {
    const transport = this.#transport;
    if (!transport || this.#state === 'disconnected' || this.#state === 'closing') return;
    if (this.#state === 'connecting') {
      this.#teardown(transport);
      this.#rejectAllPending(new SatelliteError('CONNECTION_LOST', 'Closed while connecting'));
      this.#handshake?.reject(new SatelliteError('CONNECTION_LOST', 'Closed while connecting'));
      this.#setState('disconnected');
      return;
    }
    this.#setState('closing');
    this.#stopPing();
    const perStep = Math.max(50, Math.floor(timeoutMs / 2));
    await Promise.all(
      [...this.#decks.keys()].map((deviceId) =>
        this.removeDevice(deviceId, perStep).catch(() => undefined),
      ),
    );
    try {
      this.#write({ type: 'quit' });
    } catch {
      // already gone
    }
    this.#rejectAllPending(new SatelliteError('CONNECTION_LOST', 'Client closed'));
    for (const deck of this.#decks.values()) {
      deck.markDisconnected(new SatelliteError('CONNECTION_LOST', 'Client closed'));
    }
    this.#decks.clear();
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        transport.destroy();
        done();
      }, perStep);
      const previous = transport.onClose;
      transport.onClose = (error) => {
        previous(error);
        done();
      };
      transport.close();
    });
    this.#transport = undefined;
    this.#setState('disconnected');
  }
}
