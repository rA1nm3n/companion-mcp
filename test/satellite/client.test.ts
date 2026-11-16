import { afterEach, describe, expect, it } from 'vitest';
import { loadSafetyConfig, SafetyError } from '../../src/safety/index.js';
import {
  SatelliteClient,
  SatelliteError,
  type SatelliteClientOptions,
} from '../../src/satellite/index.js';
import { MockSatelliteServer, type MockOptions } from './mock-server.js';

const SAFE = loadSafetyConfig({});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup(
  mockOptions: MockOptions = {},
  clientOptions: Partial<SatelliteClientOptions> = {},
): Promise<{ server: MockSatelliteServer; client: SatelliteClient }> {
  const server = new MockSatelliteServer(mockOptions);
  await server.start();
  const client = new SatelliteClient({
    safety: SAFE,
    ...(mockOptions.kind === 'ws' ? { transport: 'ws' as const } : {}),
    ...clientOptions,
  });
  cleanup.push(async () => {
    await client.close(200);
    await server.stop();
  });
  return { server, client };
}

describe('SatelliteClient connect and handshake', () => {
  it('connects, negotiates the version and reports capabilities', async () => {
    const { server, client } = await setup();
    expect(client.state).toBe('disconnected');
    const info = await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    expect(client.state).toBe('ready');
    expect(info.apiVersion).toBe('1.14.0');
    expect(info.companionVersion).toContain('5.1.3');
    expect(info.subscriptionsEnabled).toBe(false);
    expect(info.caps?.bitmapFormats).toEqual(['rgb', 'png', 'webp']);
    expect(info.warnings).toEqual([]);
  });

  it('warns about enabled subscriptions but never uses them', async () => {
    const { server, client } = await setup({ subscriptions: true });
    const info = await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    expect(info.subscriptionsEnabled).toBe(true);
    expect(info.warnings.join(' ')).toMatch(/subscriptions/i);
    await client.addDevice();
    expect(server.commands.some((c) => c.startsWith('ADD-SUB') || c.startsWith('SUB-'))).toBe(
      false,
    );
  });

  it('refuses hosts that are not on the allow-list before opening a socket (host gate)', async () => {
    const client = new SatelliteClient({ safety: SAFE });
    await expect(client.connect('192.0.2.10', 16622, { timeoutMs: 200 })).rejects.toMatchObject({
      name: 'SafetyError',
      code: 'HOST_NOT_ALLOWED',
    });
    expect(client.state).toBe('disconnected');
    const allowed = new SatelliteClient({
      safety: loadSafetyConfig({ COMPANION_MCP_ALLOWED_HOSTS: '192.0.2.10' }),
    });
    // allowed by the gate, but nothing listens there: connect fails with a typed error, not a SafetyError
    await expect(allowed.connect('192.0.2.10', 9, { timeoutMs: 200 })).rejects.toBeInstanceOf(
      SatelliteError,
    );
  });

  it('times out when the server never sends BEGIN', async () => {
    const { server, client } = await setup({ silent: true });
    await expect(
      client.connect('127.0.0.1', server.port, { timeoutMs: 150 }),
    ).rejects.toMatchObject({
      code: 'HANDSHAKE_TIMEOUT',
    });
    expect(client.state).toBe('disconnected');
  });

  it('fails with CONNECT_FAILED when nothing listens', async () => {
    const server = new MockSatelliteServer();
    await server.start();
    const port = server.port;
    await server.stop();
    const client = new SatelliteClient({ safety: SAFE });
    await expect(client.connect('127.0.0.1', port, { timeoutMs: 500 })).rejects.toMatchObject({
      code: 'CONNECT_FAILED',
    });
    expect(client.state).toBe('disconnected');
  });

  it('refuses too old and non-1.x API versions', async () => {
    for (const apiVersion of ['1.9.0', '2.0.0']) {
      const { server, client } = await setup({ apiVersion });
      await expect(
        client.connect('127.0.0.1', server.port, { timeoutMs: 500 }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_VERSION',
      });
      expect(client.state).toBe('disconnected');
    }
  });

  it('accepts a newer 1.x version with a warning and tolerates unknown commands', async () => {
    const { server, client } = await setup({ apiVersion: '1.16.0' });
    const info = await client.connect('127.0.0.1', server.port, { timeoutMs: 500 });
    expect(info.warnings.join(' ')).toMatch(/newer/);
    const unknown: string[] = [];
    client.onUnknown((m) => unknown.push(m.type));
    // the server answers an unknown command with ERROR MESSAGE=...; the client does not fall over
    (server.sessions[0] as { send(line: string): void }).send('ERROR MESSAGE="Unknown command: X"');
    (server.sessions[0] as { send(line: string): void }).send('DEVICE-APPEARANCE DEVICEID="x"');
    await sleep(30);
    expect(unknown).toEqual(['error', 'unknown']);
    expect(client.state).toBe('ready');
  });

  it('rejects a second connect while connected', async () => {
    const { server, client } = await setup();
    await client.connect('127.0.0.1', server.port, { timeoutMs: 500 });
    await expect(client.connect('127.0.0.1', server.port)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('works over the WebSocket transport', async () => {
    const { server, client } = await setup({ kind: 'ws' });
    const info = await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    expect(info.apiVersion).toBe('1.14.0');
    const deck = await client.addDevice();
    const snapshot = await deck.snapshotPage({ quietMs: 50, timeoutMs: 1000 });
    expect(snapshot.complete).toBe(true);
    expect(deck.getKey(0, 0)?.text).toBe('SET');
  });
});

describe('SatelliteClient devices', () => {
  it('adds an 8x4 virtual deck with the measured ADD-DEVICE line and receives an unordered flood', async () => {
    const { server, client } = await setup();
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    const deck = await client.addDevice({ deviceId: 'mcp-test' });
    expect(server.received.find((l) => l.startsWith('ADD-DEVICE'))).toBe(
      'ADD-DEVICE DEVICEID="mcp-test" PRODUCT_NAME="Companion MCP virtual deck" KEYS_TOTAL=32 KEYS_PER_ROW=8 COLORS="hex" TEXT=1 TEXT_STYLE=1',
    );
    const snapshot = await deck.snapshotPage({ quietMs: 50, timeoutMs: 1000 });
    expect(snapshot.page).toBe(1);
    expect(snapshot.complete).toBe(true);
    expect(deck.rows).toBe(4);
    expect(deck.brightness).toBe(100);
    expect(deck.getKey(0, 0)).toMatchObject({ text: 'SET', color: '#00ff00', key: 0 });
    expect(deck.getKey(0, 1)).toMatchObject({ text: 'RESET', color: '#0000ff' });
    expect(deck.getKey(2, 2)).toMatchObject({ text: '', color: '#000000', fontSize: 'auto' });
  });

  it('supports other geometries and bitmaps (png falls back to rgb when not offered)', async () => {
    const { server, client } = await setup();
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    const deck = await client.addDevice({
      deviceId: 'five-by-three',
      keysTotal: 15,
      keysPerRow: 5,
      bitmapSize: 72,
      bitmapFormat: 'png',
    });
    expect(deck.bitmapFormat).toBe('png');
    const line = server.received.find((l) => l.startsWith('ADD-DEVICE')) ?? '';
    expect(line).toContain('KEYS_TOTAL=15 KEYS_PER_ROW=5 BITMAPS=72');
    expect(line).toContain('BITMAP_FORMAT="png"');
    const snapshot = await deck.snapshotPage({ quietMs: 50, timeoutMs: 1000 });
    expect(snapshot.cells).toHaveLength(15);
    expect(deck.getKey(0, 0)?.bitmap?.format).toBe('png');

    const { server: server2, client: client2 } = await setup({ bitmapFormats: 'rgb' });
    await client2.connect('127.0.0.1', server2.port, { timeoutMs: 1000 });
    const deck2 = await client2.addDevice({ bitmapSize: 72, bitmapFormat: 'png' });
    expect(deck2.bitmapFormat).toBe('rgb');
    expect(server2.received.find((l) => l.startsWith('ADD-DEVICE'))).not.toContain('BITMAP_FORMAT');
  });

  it('rejects unsafe DEVICEIDs and invalid geometry before sending anything', async () => {
    const { server, client } = await setup();
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    await expect(client.addDevice({ deviceId: 'a"b' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(client.addDevice({ keysTotal: 5000 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(server.commands).not.toContain('ADD-DEVICE');
    expect(client.devices).toHaveLength(0);
  });

  it('turns ADD-DEVICE ERROR into COMMAND_REJECTED', async () => {
    const { server, client } = await setup({ rejectAddDevice: 'Device already added' });
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    await expect(client.addDevice()).rejects.toMatchObject({
      code: 'COMMAND_REJECTED',
      message: expect.stringContaining('Device already added'),
    });
    expect(client.devices).toHaveLength(0);
  });

  it('times out ADD-DEVICE when the answer goes to another owner (duplicate DEVICEID)', async () => {
    const { server, client } = await setup({ ignoreAddDevice: true });
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    await expect(client.addDevice({ timeoutMs: 100 })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: expect.stringContaining('connected elsewhere'),
    });
    expect(client.devices).toHaveLength(0);
  });

  it('removes a device cleanly and rejects a second removal', async () => {
    const { server, client } = await setup();
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    await client.addDevice();
    await client.removeDevice('mcp-virtual-deck');
    expect(server.commands).toContain('REMOVE-DEVICE');
    expect(client.devices).toHaveLength(0);
    await expect(client.removeDevice('mcp-virtual-deck')).rejects.toMatchObject({
      code: 'DEVICE_UNKNOWN',
    });
  });

  it('refuses addDevice when not ready', async () => {
    const client = new SatelliteClient({ safety: SAFE });
    await expect(client.addDevice()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('SatelliteClient keepalive and failure', () => {
  it('sends PING often enough to survive the server idle timeout (PING obligation)', async () => {
    const { server, client } = await setup({ idleTimeoutMs: 300 }, { pingIntervalMs: 100 });
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    await sleep(1000); // more than three idle timeouts
    expect(client.state).toBe('ready');
    expect(server.commands.filter((c) => c === 'PING').length).toBeGreaterThanOrEqual(5);
  });

  it('is dropped by the server without PING and reports CONNECTION_LOST (no silent reconnect)', async () => {
    const { server, client } = await setup({ idleTimeoutMs: 150 }, { pingIntervalMs: 4000 });
    const errors: SatelliteError[] = [];
    client.onError((e) => errors.push(e));
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    const deck = await client.addDevice();
    await sleep(500);
    expect(client.state).toBe('disconnected');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('CONNECTION_LOST');
    expect(deck.connected).toBe(false);
    expect(server.sessions).toHaveLength(1); // nobody reconnected
    await expect(deck.snapshotPage({ timeoutMs: 50 })).rejects.toMatchObject({
      code: 'CONNECTION_LOST',
    });
    await expect(client.addDevice()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('allows an explicit new connect after a loss', async () => {
    const { server, client } = await setup({ idleTimeoutMs: 100 }, { pingIntervalMs: 4000 });
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    await sleep(300);
    expect(client.state).toBe('disconnected');
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    expect(client.state).toBe('ready');
  });

  it('ends the connection with PONG_TIMEOUT when PING is not answered', async () => {
    const { server, client } = await setup(
      { ignorePing: true },
      { pingIntervalMs: 50, pongTimeoutMs: 120 },
    );
    const errors: SatelliteError[] = [];
    client.onError((e) => errors.push(e));
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    await sleep(400);
    expect(client.state).toBe('disconnected');
    expect(errors[0]?.code).toBe('PONG_TIMEOUT');
  });

  it('rejects ping intervals that would not keep the connection alive', () => {
    expect(() => new SatelliteClient({ safety: SAFE, pingIntervalMs: 5000 })).toThrow(
      SatelliteError,
    );
    expect(() => new SatelliteClient({ safety: SAFE, pingIntervalMs: 5 })).toThrow(SatelliteError);
  });

  it('rejects pending requests with CONNECTION_LOST when the server drops', async () => {
    const { server, client } = await setup({ ignoreAddDevice: true });
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    const pending = client.addDevice({ timeoutMs: 2000 });
    await sleep(30);
    server.sessions[0]?.destroy();
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  it('handles CRLF lines from the server', async () => {
    const { server, client } = await setup({ crlf: true });
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    const deck = await client.addDevice();
    await deck.snapshotPage({ quietMs: 50, timeoutMs: 1000 });
    expect(deck.getKey(0, 0)?.text).toBe('SET');
  });
});

describe('SatelliteClient close', () => {
  it('removes devices, sends QUIT and ends disconnected; close is idempotent', async () => {
    const { server, client } = await setup();
    const states: string[] = [];
    client.onState((s) => states.push(s));
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    const deck = await client.addDevice();
    await client.close();
    expect(client.state).toBe('disconnected');
    expect(server.commands).toContain('REMOVE-DEVICE');
    expect(server.commands.at(-1)).toBe('QUIT');
    expect(deck.connected).toBe(false);
    expect(states).toEqual(['connecting', 'ready', 'closing', 'disconnected']);
    await client.close();
    expect(client.state).toBe('disconnected');
  });

  it('close does not hang when the server is unresponsive', async () => {
    const { server, client } = await setup({ ignorePing: true, ignoreAddDevice: false });
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    await client.addDevice();
    server.sessions[0]?.destroy();
    const started = Date.now();
    await client.close(300);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(client.state).toBe('disconnected');
  });

  it('never sends subscription, variable or page-change commands', async () => {
    const { server, client } = await setup();
    await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
    await client.addDevice();
    await client.close();
    for (const command of server.commands) {
      expect(['ADD-DEVICE', 'REMOVE-DEVICE', 'PING', 'QUIT', 'KEY-PRESS']).toContain(command);
    }
  });
});

describe('SafetyError type', () => {
  it('is what the host gate throws', async () => {
    const client = new SatelliteClient({ safety: SAFE });
    await expect(client.connect('evil.example')).rejects.toBeInstanceOf(SafetyError);
  });
});
