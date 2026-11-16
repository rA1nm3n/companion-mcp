import { SatelliteError } from './errors.js';

/**
 * Satellite API line protocol (Companion 5.1.3, ApiVersion 1.14.0, measured).
 *
 * A line is `COMMAND [OK|ERROR] KEY=VALUE KEY="value with spaces" ...`. Parsing follows Companion's own
 * `parseLineParameters`: space separates tokens outside of `"..."`, a quote toggles the protection and is
 * removed, a backslash escapes the next character, the first `=` splits (Base64 padding survives), a token
 * without `=` becomes `true`. The server writes numbers unquoted and strings always quoted without escaping,
 * so the same field can arrive as `FONT_SIZE=21.1` and `FONT_SIZE="auto"`; both parse to a string here.
 */

export type ParamValue = string | true;

export interface ParsedLine {
  /** Upper-cased command name (command names are case-insensitive on the wire). */
  command: string;
  status: 'OK' | 'ERROR' | null;
  /** Parameter names are case-sensitive. Prototype-less object: hostile names cannot pollute anything. */
  params: Readonly<Record<string, ParamValue>>;
  raw: string;
}

/** Never throws, for any input. */
export function parseLine(line: string): ParsedLine {
  const fragments: string[] = [''];
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    const last = fragments.length - 1;
    if (char === '\\') {
      i++;
      fragments[last] = (fragments[last] ?? '') + line.charAt(i);
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ' ' && !quoted) {
      fragments.push('');
    } else {
      fragments[last] = (fragments[last] ?? '') + char;
    }
  }
  const tokens = fragments.filter((fragment) => fragment !== '');
  const command = (tokens.shift() ?? '').toUpperCase();
  let status: 'OK' | 'ERROR' | null = null;
  if (tokens[0] === 'OK' || tokens[0] === 'ERROR') {
    status = tokens[0];
    tokens.shift();
  }
  const params: Record<string, ParamValue> = Object.create(null) as Record<string, ParamValue>;
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq === -1) params[token] = true;
    else params[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { command, status, params, raw: line };
}

// ---------------------------------------------------------------------------------------------------------
// Server to client messages

export interface KeyLocation {
  page: number;
  row: number;
  column: number;
}

export type BitmapFormat = 'rgb' | 'png' | 'webp';

/** Bitmaps stay bytes: `base64` is the payload without the data-URL prefix. The bitmap includes the topbar. */
export interface Bitmap {
  format: BitmapFormat;
  base64: string;
}

export interface BeginMessage {
  type: 'begin';
  companionVersion: string | null;
  apiVersion: string | null;
}

export interface CapsMessage {
  type: 'caps';
  /** `SUBSCRIPTIONS=1` means the operator enabled subscriptions (they bypass the PIN). Never used by this client. */
  subscriptions: boolean;
  bitmapFormats: string[];
  params: Readonly<Record<string, ParamValue>>;
}

export interface KeyStateMessage {
  type: 'key-state';
  deviceId: string;
  /** Legacy key index (`KEY`), null when absent. */
  key: number | null;
  /** `LOCATION="page/row/column"`: the Companion button shown, null when absent or malformed. */
  location: KeyLocation | null;
  pressed: boolean;
  keyType: string | null;
  bitmap: Bitmap | null;
  color: string | null;
  textColor: string | null;
  /** Decoded `TEXT` (Base64 UTF-8 on the wire). Plain button text, without the topbar. */
  text: string | null;
  fontSize: number | 'auto' | null;
}

export interface BrightnessMessage {
  type: 'brightness';
  deviceId: string;
  value: number;
}

export interface LockedStateMessage {
  type: 'locked-state';
  deviceId: string;
  locked: boolean;
  characterCount: number | null;
}

export interface KeysClearMessage {
  type: 'keys-clear';
  deviceId: string;
}

export interface PongMessage {
  type: 'pong';
  payload: string;
}

/**
 * Answer to a command: `CMD OK ...` or `CMD ERROR ... MESSAGE="..."`. There are no request IDs; answers are
 * matched by command and DEVICEID. `OK` only means "the server accepted the line", never "the effect happened".
 */
export interface ResponseMessage {
  type: 'response';
  command: string;
  ok: boolean;
  deviceId: string | null;
  message: string | null;
  params: Readonly<Record<string, ParamValue>>;
}

/** Generic `ERROR MESSAGE="..."` without a command (unknown command, line too long). */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** Anything not understood. Kept (not thrown) so newer servers and web-doc-only commands are tolerated. */
export interface UnknownMessage {
  type: 'unknown';
  command: string;
  raw: string;
  reason: string;
}

export type ServerMessage =
  | BeginMessage
  | CapsMessage
  | KeyStateMessage
  | BrightnessMessage
  | LockedStateMessage
  | KeysClearMessage
  | PongMessage
  | ResponseMessage
  | ErrorMessage
  | UnknownMessage;

function str(params: ParsedLine['params'], name: string): string | null {
  const value = params[name];
  return typeof value === 'string' ? value : null;
}

function int(params: ParsedLine['params'], name: string): number | null {
  const value = str(params, name);
  if (value === null || !/^-?\d+$/.test(value)) return null;
  return Number(value);
}

function flag(params: ParsedLine['params'], name: string): boolean {
  const value = params[name];
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes';
}

export function parseLocation(value: string | null): KeyLocation | null {
  if (value === null) return null;
  const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  return { page: Number(match[1]), row: Number(match[2]), column: Number(match[3]) };
}

/** `data:image/png;base64,...` / `data:image/webp;base64,...` or raw Base64 of w*h*3 RGB bytes. */
export function parseBitmap(value: string | null): Bitmap | null {
  if (value === null || value === '') return null;
  if (value.startsWith('data:')) {
    const match = /^data:image\/(png|webp);base64,(.*)$/s.exec(value);
    if (!match) return null;
    return { format: match[1] === 'png' ? 'png' : 'webp', base64: match[2] ?? '' };
  }
  return { format: 'rgb', base64: value };
}

function decodeText(value: string | null): string | null {
  if (value === null) return null;
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseFontSize(value: string | null): number | 'auto' | null {
  if (value === null) return null;
  if (value === 'auto') return 'auto';
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Parses one server line. Never throws: unrecognised or malformed lines become `{ type: 'unknown' }`. */
export function parseServerLine(line: string): ServerMessage {
  const parsed = parseLine(line);
  const { command, status, params } = parsed;
  const unknown = (reason: string): UnknownMessage => ({
    type: 'unknown',
    command,
    raw: line,
    reason,
  });
  const deviceId = str(params, 'DEVICEID');

  if (command === '') return unknown('empty line');

  if (command === 'ERROR') {
    return { type: 'error', message: str(params, 'MESSAGE') ?? '' };
  }
  if (command === 'PONG') {
    return { type: 'pong', payload: line.slice(command.length).trim() };
  }
  if (status !== null) {
    return {
      type: 'response',
      command,
      ok: status === 'OK',
      deviceId,
      message: str(params, 'MESSAGE'),
      params,
    };
  }

  switch (command) {
    case 'BEGIN':
      return {
        type: 'begin',
        companionVersion: str(params, 'CompanionVersion'),
        apiVersion: str(params, 'ApiVersion'),
      };
    case 'CAPS': {
      const formats = str(params, 'BITMAP_FORMATS');
      return {
        type: 'caps',
        subscriptions: flag(params, 'SUBSCRIPTIONS'),
        bitmapFormats: formats === null ? [] : formats.split(',').filter((entry) => entry !== ''),
        params,
      };
    }
    case 'KEY-STATE': {
      if (deviceId === null) return unknown('KEY-STATE without DEVICEID');
      return {
        type: 'key-state',
        deviceId,
        key: int(params, 'KEY'),
        location: parseLocation(str(params, 'LOCATION')),
        pressed: flag(params, 'PRESSED'),
        keyType: str(params, 'TYPE'),
        bitmap: parseBitmap(str(params, 'BITMAP')),
        color: str(params, 'COLOR'),
        textColor: str(params, 'TEXTCOLOR'),
        text: decodeText(str(params, 'TEXT')),
        fontSize: parseFontSize(str(params, 'FONT_SIZE')),
      };
    }
    case 'BRIGHTNESS': {
      const value = int(params, 'VALUE');
      if (deviceId === null || value === null) return unknown('BRIGHTNESS without DEVICEID/VALUE');
      return { type: 'brightness', deviceId, value };
    }
    case 'LOCKED-STATE':
      if (deviceId === null) return unknown('LOCKED-STATE without DEVICEID');
      return {
        type: 'locked-state',
        deviceId,
        locked: flag(params, 'LOCKED'),
        characterCount: int(params, 'CHARACTER_COUNT'),
      };
    case 'KEYS-CLEAR':
      if (deviceId === null) return unknown('KEYS-CLEAR without DEVICEID');
      return { type: 'keys-clear', deviceId };
    default:
      return unknown('unrecognised command');
  }
}

// ---------------------------------------------------------------------------------------------------------
// Client to server commands

/** DEVICEIDs are echoed unescaped by Companion (measured), so only a safe alphabet is allowed. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function assertSafeDeviceId(deviceId: string): void {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new SatelliteError('INVALID_ARGUMENT', 'deviceId must match [A-Za-z0-9_-]{1,64}');
  }
}

/**
 * The only commands this client can produce. There is deliberately no ADD-SUB / SUB-PRESS (subscriptions bypass
 * the PIN), no SET-VARIABLE-VALUE, no FIRMWARE-UPDATE-INFO, no CONFIG_FIELDS and no CHANGE-PAGE.
 */
export type ClientCommand =
  | { type: 'ping'; payload?: string }
  | { type: 'quit' }
  | {
      type: 'add-device';
      deviceId: string;
      productName: string;
      keysTotal: number;
      keysPerRow: number;
      /** Bitmap edge length in pixels (`BITMAPS=<px>`); omitted: text/colour only. */
      bitmapSize?: number;
      /** `BITMAP_FORMAT`, only valid with `bitmapSize`. Omitted: server default (rgb). */
      bitmapFormat?: BitmapFormat;
      colors?: 'hex' | 'rgb';
      text: boolean;
      textStyle: boolean;
    }
  | { type: 'remove-device'; deviceId: string }
  | { type: 'key-press'; deviceId: string; key: number; pressed: boolean }
  | { type: 'key-rotate'; deviceId: string; key: number; direction: number };

/** Strings always quoted with `\` and `"` escaped, numbers and booleans bare (booleans as 0/1). */
export function formatValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SatelliteError('INVALID_ARGUMENT', 'Numbers on the wire must be finite');
    }
    return String(value);
  }
  if (/[\r\n]/.test(value)) {
    throw new SatelliteError('INVALID_ARGUMENT', 'Values must not contain line breaks');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function build(command: string, args: Array<[string, string | number | boolean]>): string {
  return [command, ...args.map(([name, value]) => `${name}=${formatValue(value)}`)].join(' ');
}

function assertIndex(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 1999) {
    throw new SatelliteError('INVALID_ARGUMENT', `${name} must be an integer in 0..1999`);
  }
}

/** Serializes a command to one wire line without the trailing newline. */
export function serializeCommand(command: ClientCommand): string {
  switch (command.type) {
    case 'ping':
      if (command.payload === undefined) return 'PING';
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(command.payload)) {
        throw new SatelliteError('INVALID_ARGUMENT', 'PING payload must match [A-Za-z0-9_-]{1,32}');
      }
      return `PING ${command.payload}`;
    case 'quit':
      return 'QUIT';
    case 'add-device': {
      assertSafeDeviceId(command.deviceId);
      if (
        !Number.isInteger(command.keysTotal) ||
        command.keysTotal < 1 ||
        command.keysTotal > 2000
      ) {
        throw new SatelliteError('INVALID_ARGUMENT', 'keysTotal must be an integer in 1..2000');
      }
      if (
        !Number.isInteger(command.keysPerRow) ||
        command.keysPerRow < 1 ||
        command.keysPerRow > 1000
      ) {
        throw new SatelliteError('INVALID_ARGUMENT', 'keysPerRow must be an integer in 1..1000');
      }
      const args: Array<[string, string | number | boolean]> = [
        ['DEVICEID', command.deviceId],
        ['PRODUCT_NAME', command.productName],
        ['KEYS_TOTAL', command.keysTotal],
        ['KEYS_PER_ROW', command.keysPerRow],
      ];
      if (command.bitmapSize !== undefined) {
        if (!Number.isInteger(command.bitmapSize) || command.bitmapSize < 8) {
          throw new SatelliteError('INVALID_ARGUMENT', 'bitmapSize must be an integer >= 8');
        }
        args.push(['BITMAPS', command.bitmapSize]);
      }
      if (command.colors !== undefined) args.push(['COLORS', command.colors]);
      args.push(['TEXT', command.text], ['TEXT_STYLE', command.textStyle]);
      if (command.bitmapFormat !== undefined) args.push(['BITMAP_FORMAT', command.bitmapFormat]);
      return build('ADD-DEVICE', args);
    }
    case 'remove-device':
      assertSafeDeviceId(command.deviceId);
      return build('REMOVE-DEVICE', [['DEVICEID', command.deviceId]]);
    case 'key-press':
      assertSafeDeviceId(command.deviceId);
      assertIndex('key', command.key);
      return build('KEY-PRESS', [
        ['DEVICEID', command.deviceId],
        ['KEY', command.key],
        ['PRESSED', command.pressed],
      ]);
    case 'key-rotate':
      assertSafeDeviceId(command.deviceId);
      assertIndex('key', command.key);
      if (!Number.isInteger(command.direction) || Math.abs(command.direction) > 100) {
        throw new SatelliteError('INVALID_ARGUMENT', 'direction must be an integer in -100..100');
      }
      return build('KEY-ROTATE', [
        ['DEVICEID', command.deviceId],
        ['KEY', command.key],
        ['DIRECTION', command.direction],
      ]);
  }
}

/** Compares `1.14.0`-style versions numerically. Returns null when either side is not `x.y[.z]`. */
export function compareApiVersions(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
