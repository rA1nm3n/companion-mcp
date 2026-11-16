import { describe, expect, it } from 'vitest';
import {
  assertSafeDeviceId,
  compareApiVersions,
  formatValue,
  parseLine,
  parseServerLine,
  serializeCommand,
  SatelliteError,
} from '../../src/satellite/index.js';

// Lines below are copied from the measured wire logs (headless/satellite/out/wire-*.txt), bitmaps shortened.
const BEGIN = 'BEGIN CompanionVersion="5.1.3+1-unknown-93ea3fa61c" ApiVersion="1.14.0" ';
const CAPS = 'CAPS SUBSCRIPTIONS=0 NONSQUARE=1 BITMAP_FORMATS="rgb,png,webp" ROTARY_AMOUNT=1 ';
const KEY_SET =
  'KEY-STATE DEVICEID="probe-lock" KEY=0 LOCATION="1/0/0" PRESSED=0 TYPE="BUTTON" BITMAP="AAAAAAAA" COLOR="#00ff00" TEXTCOLOR="#000000" TEXT="U0VU" FONT_SIZE=21.1 ';
const KEY_EMPTY =
  'KEY-STATE DEVICEID="probe-lock" KEY=2 LOCATION="1/0/2" PRESSED=0 TYPE="BUTTON" BITMAP="AAAAAAAA" COLOR="#000000" TEXTCOLOR="#000000" TEXT="" FONT_SIZE="auto" ';

describe('parseLine', () => {
  it('parses BEGIN with quoted values and trailing space', () => {
    const line = parseLine(BEGIN);
    expect(line.command).toBe('BEGIN');
    expect(line.status).toBeNull();
    expect(line.params['ApiVersion']).toBe('1.14.0');
    expect(line.params['CompanionVersion']).toBe('5.1.3+1-unknown-93ea3fa61c');
  });

  it('keeps Base64 padding and splits at the first equals sign only', () => {
    const line = parseLine(
      'KEY-STATE DEVICEID="a" TEXT="UkVTRVQ=" BITMAP="data:image/png;base64,iVBOR=="',
    );
    expect(line.params['TEXT']).toBe('UkVTRVQ=');
    expect(line.params['BITMAP']).toBe('data:image/png;base64,iVBOR==');
  });

  it('reads OK and ERROR status and bare flags', () => {
    expect(parseLine('KEY-PRESS OK DEVICEID="x"').status).toBe('OK');
    const error = parseLine('KEY-PRESS ERROR DEVICEID="nope" MESSAGE="Device not found"');
    expect(error.status).toBe('ERROR');
    expect(error.params['MESSAGE']).toBe('Device not found');
    expect(parseLine('FOO BAR').params['BAR']).toBe(true);
  });

  it('treats command names case-insensitively and survives CRLF-free odd input', () => {
    expect(parseLine('ping lower').command).toBe('PING');
    expect(parseLine('').command).toBe('');
    expect(() => parseLine('A="unterminated \\')).not.toThrow();
  });

  it('survives the unescaped echo DEVICEID="a"b" measured in X3', () => {
    const line = parseLine('ADD-DEVICE ERROR DEVICEID="a"b" MESSAGE="Device already added"');
    expect(line.status).toBe('ERROR');
    expect(typeof line.params['DEVICEID']).toBe('string');
  });

  it('does not pollute prototypes with hostile parameter names', () => {
    const line = parseLine('X __proto__=1 constructor=2');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(line.params['constructor']).toBe('2');
  });

  it('never throws on random input', () => {
    const alphabet = ['"', '\\', ' ', '=', 'A', 'b', '1', '\n', '\u{1F512}'];
    let seed = 12345;
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 500; i++) {
      let line = '';
      const length = next() % 60;
      for (let j = 0; j < length; j++) line += alphabet[next() % alphabet.length];
      expect(() => parseServerLine(line)).not.toThrow();
    }
  });
});

describe('parseServerLine', () => {
  it('parses BEGIN and CAPS', () => {
    expect(parseServerLine(BEGIN)).toEqual({
      type: 'begin',
      companionVersion: '5.1.3+1-unknown-93ea3fa61c',
      apiVersion: '1.14.0',
    });
    const caps = parseServerLine(CAPS);
    expect(caps).toMatchObject({
      type: 'caps',
      subscriptions: false,
      bitmapFormats: ['rgb', 'png', 'webp'],
    });
  });

  it('reports SUBSCRIPTIONS=1', () => {
    expect(parseServerLine('CAPS SUBSCRIPTIONS=1')).toMatchObject({ subscriptions: true });
  });

  it('parses KEY-STATE with unquoted FONT_SIZE=21.1 and decodes TEXT', () => {
    expect(parseServerLine(KEY_SET)).toEqual({
      type: 'key-state',
      deviceId: 'probe-lock',
      key: 0,
      location: { page: 1, row: 0, column: 0 },
      pressed: false,
      keyType: 'BUTTON',
      bitmap: { format: 'rgb', base64: 'AAAAAAAA' },
      color: '#00ff00',
      textColor: '#000000',
      text: 'SET',
      fontSize: 21.1,
    });
  });

  it('parses an empty key with quoted FONT_SIZE="auto" and TEXT=""', () => {
    expect(parseServerLine(KEY_EMPTY)).toMatchObject({ text: '', fontSize: 'auto', key: 2 });
  });

  it('decodes UTF-8 text such as the lock icon', () => {
    const text = Buffer.from('\u{1F512}').toString('base64');
    expect(
      parseServerLine(`KEY-STATE DEVICEID="d" KEY=0 LOCATION="1/0/0" PRESSED=0 TEXT="${text}"`),
    ).toMatchObject({ text: '\u{1F512}' });
  });

  it('parses png and webp data URLs and keeps the bytes as Base64', () => {
    expect(
      parseServerLine(
        'KEY-STATE DEVICEID="d" KEY=1 LOCATION="1/0/1" BITMAP="data:image/png;base64,iVBORw0KGgo="',
      ),
    ).toMatchObject({ bitmap: { format: 'png', base64: 'iVBORw0KGgo=' } });
    expect(
      parseServerLine(
        'KEY-STATE DEVICEID="d" KEY=1 LOCATION="1/0/1" BITMAP="data:image/webp;base64,UklGRg=="',
      ),
    ).toMatchObject({ bitmap: { format: 'webp', base64: 'UklGRg==' } });
  });

  it('handles PONG with trailing space and empty payload', () => {
    expect(parseServerLine('PONG abc 123 ')).toEqual({ type: 'pong', payload: 'abc 123' });
    expect(parseServerLine('PONG  ')).toEqual({ type: 'pong', payload: '' });
  });

  it('parses BRIGHTNESS, LOCKED-STATE, KEYS-CLEAR', () => {
    expect(parseServerLine('BRIGHTNESS DEVICEID="d" VALUE=100 ')).toEqual({
      type: 'brightness',
      deviceId: 'd',
      value: 100,
    });
    expect(
      parseServerLine('LOCKED-STATE DEVICEID="d" LOCKED=1 CHARACTER_COUNT=2 ROTATION=0 '),
    ).toEqual({ type: 'locked-state', deviceId: 'd', locked: true, characterCount: 2 });
    expect(parseServerLine('KEYS-CLEAR DEVICEID="d"')).toEqual({
      type: 'keys-clear',
      deviceId: 'd',
    });
  });

  it('parses responses, errors and the generic ERROR line', () => {
    expect(parseServerLine('ADD-DEVICE OK DEVICEID="x" ')).toMatchObject({
      type: 'response',
      command: 'ADD-DEVICE',
      ok: true,
      deviceId: 'x',
    });
    expect(
      parseServerLine('KEY-PRESS ERROR DEVICEID="nope" MESSAGE="Device not found" '),
    ).toMatchObject({
      type: 'response',
      ok: false,
      message: 'Device not found',
    });
    expect(parseServerLine('ERROR MESSAGE="Unknown command: FOO" ')).toEqual({
      type: 'error',
      message: 'Unknown command: FOO',
    });
    expect(parseServerLine('ERROR ERROR MESSAGE="Line too long"')).toEqual({
      type: 'error',
      message: 'Line too long',
    });
  });

  it('tolerates unknown and malformed lines (web-doc-only commands)', () => {
    expect(parseServerLine('DEVICE-APPEARANCE DEVICEID="x" X=1')).toMatchObject({
      type: 'unknown',
      command: 'DEVICE-APPEARANCE',
    });
    expect(parseServerLine('KEY-STATE KEY=1')).toMatchObject({ type: 'unknown' });
    expect(parseServerLine('')).toMatchObject({ type: 'unknown' });
  });

  it('keeps a KEY-STATE without LOCATION but with location null', () => {
    expect(parseServerLine('KEY-STATE DEVICEID="d" KEY=1 LOCATION="oops"')).toMatchObject({
      type: 'key-state',
      location: null,
    });
  });
});

describe('serializeCommand', () => {
  it('writes ADD-DEVICE like the measured Legacy-32 client', () => {
    expect(
      serializeCommand({
        type: 'add-device',
        deviceId: 'probe-lock',
        productName: 'Probe Lock Full',
        keysTotal: 32,
        keysPerRow: 8,
        bitmapSize: 72,
        colors: 'hex',
        text: true,
        textStyle: true,
      }),
    ).toBe(
      'ADD-DEVICE DEVICEID="probe-lock" PRODUCT_NAME="Probe Lock Full" KEYS_TOTAL=32 KEYS_PER_ROW=8 BITMAPS=72 COLORS="hex" TEXT=1 TEXT_STYLE=1',
    );
  });

  it('writes KEY-PRESS, REMOVE-DEVICE, PING, QUIT', () => {
    expect(serializeCommand({ type: 'key-press', deviceId: 'd', key: 0, pressed: true })).toBe(
      'KEY-PRESS DEVICEID="d" KEY=0 PRESSED=1',
    );
    expect(serializeCommand({ type: 'key-press', deviceId: 'd', key: 31, pressed: false })).toBe(
      'KEY-PRESS DEVICEID="d" KEY=31 PRESSED=0',
    );
    expect(serializeCommand({ type: 'remove-device', deviceId: 'd' })).toBe(
      'REMOVE-DEVICE DEVICEID="d"',
    );
    expect(serializeCommand({ type: 'ping' })).toBe('PING');
    expect(serializeCommand({ type: 'ping', payload: 'k1' })).toBe('PING k1');
    expect(serializeCommand({ type: 'quit' })).toBe('QUIT');
    expect(serializeCommand({ type: 'key-rotate', deviceId: 'd', key: 3, direction: -1 })).toBe(
      'KEY-ROTATE DEVICEID="d" KEY=3 DIRECTION=-1',
    );
  });

  it('escapes quotes and backslashes and refuses line breaks', () => {
    expect(formatValue('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(() => formatValue('a\nb')).toThrow(SatelliteError);
    expect(parseLine(`X V=${formatValue('a"b\\c d')}`).params['V']).toBe('a"b\\c d');
  });

  it('rejects unsafe DEVICEIDs and out-of-range values', () => {
    for (const id of ['a"b', 'a b', '', 'x'.repeat(65), 'ä']) {
      expect(() => assertSafeDeviceId(id)).toThrow(SatelliteError);
    }
    expect(() =>
      serializeCommand({ type: 'key-press', deviceId: 'd', key: -1, pressed: true }),
    ).toThrow(SatelliteError);
    expect(() =>
      serializeCommand({
        type: 'add-device',
        deviceId: 'd',
        productName: 'p',
        keysTotal: 2001,
        keysPerRow: 8,
        text: true,
        textStyle: true,
      }),
    ).toThrow(SatelliteError);
  });

  it('has no command type for subscriptions, variables or page changes', () => {
    const lines = [
      serializeCommand({ type: 'ping' }),
      serializeCommand({ type: 'quit' }),
      serializeCommand({ type: 'remove-device', deviceId: 'd' }),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/SUB|VARIABLE|CHANGE-PAGE|FIRMWARE|CONFIG/);
    }
  });
});

describe('compareApiVersions', () => {
  it('compares numerically', () => {
    expect(compareApiVersions('1.14.0', '1.10.0')).toBe(1);
    expect(compareApiVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareApiVersions('1.14', '1.14.0')).toBe(0);
    expect(compareApiVersions('x', '1.0.0')).toBeNull();
  });
});
