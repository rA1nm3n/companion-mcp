import { afterEach, describe, expect, it } from 'vitest';
import { loadSafetyConfig, type SafetyConfig } from '../../src/safety/index.js';
import {
  pressVerified,
  planPress,
  SatelliteClient,
  type VirtualDeck,
} from '../../src/satellite/index.js';
import { MockSatelliteServer, type MockOptions } from './mock-server.js';

const WRITE = loadSafetyConfig({ COMPANION_MCP_WRITE: '1' });
const READ_ONLY = loadSafetyConfig({});
const FAST = { quietMs: 40, changeTimeoutMs: 300, snapshotTimeoutMs: 1500 };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup(
  safety: SafetyConfig,
  mockOptions: MockOptions = {},
  readFirst = true,
): Promise<{ server: MockSatelliteServer; client: SatelliteClient; deck: VirtualDeck }> {
  const server = new MockSatelliteServer(mockOptions);
  await server.start();
  const client = new SatelliteClient({ safety });
  cleanup.push(async () => {
    await client.close(200);
    await server.stop();
  });
  await client.connect('127.0.0.1', server.port, { timeoutMs: 1000 });
  const deck = await client.addDevice();
  if (readFirst) await deck.snapshotPage({ quietMs: 40, timeoutMs: 1500 });
  return { server, client, deck };
}

const keyPresses = (server: MockSatelliteServer): string[] =>
  server.received.filter((line) => line.startsWith('KEY-PRESS'));

describe('pressVerified', () => {
  it('presses SET, sees the render change (feedback) and reports render_changed with before/after', async () => {
    const { server, client, deck } = await setup(WRITE);
    const result = await pressVerified(client, deck, 0, 0, { dryRun: false, ...FAST });
    expect(result.sent).toBe(true);
    expect(result.renderChanged).toBe(true);
    expect(result.targetChanged).toBe(true);
    expect(result.level).toBe('render_changed');
    expect(result.before).toMatchObject({ text: 'SET', color: '#00ff00' });
    expect(result.after).toMatchObject({ text: 'SET', color: '#ff0000', pressed: false });
    // the feedback also changed RESET: all keys are compared, not only the pressed one
    expect(result.changes.map((c) => [c.row, c.column])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(result.pageChanged).toBe(false);
    expect(result.location).toEqual({ page: 1, row: 0, column: 0 });
    expect(result.warnings).toEqual([]);
    expect(keyPresses(server)).toEqual([
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=1',
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=0',
    ]);
  });

  it('empty key: server answers OK, nothing changes, renderChanged is false (OK is no proof)', async () => {
    const { server, client, deck } = await setup(WRITE);
    const result = await pressVerified(client, deck, 3, 5, { dryRun: false, ...FAST });
    expect(result.sent).toBe(true);
    expect(result.renderChanged).toBe(false);
    expect(result.level).toBe('accepted');
    expect(result.changes).toEqual([]);
    expect(result.ackMs).toBeGreaterThanOrEqual(0);
    expect(keyPresses(server)).toHaveLength(2); // down and up were sent and acknowledged with OK
  });

  it('a press highlight that settles back to the same look is not a render change', async () => {
    const { client, deck } = await setup(WRITE);
    const result = await pressVerified(client, deck, 0, 3, { dryRun: false, ...FAST });
    expect(result.before.text).toBe('FLICK');
    expect(result.renderChanged).toBe(false);
    expect(result.after).toMatchObject({ color: '#808080', pressed: false });
  });

  it('a navigation key changes the page and reports pageChanged (including a late KEY-STATE)', async () => {
    const { client, deck } = await setup(WRITE, { latePageKeyDelayMs: 120 });
    const result = await pressVerified(client, deck, 1, 0, { dryRun: false, ...FAST });
    expect(result.renderChanged).toBe(true);
    expect(result.pageChanged).toBe(true);
    const snapshot = await deck.snapshotPage({ page: 2, quietMs: 40, timeoutMs: 1000 });
    expect(snapshot.complete).toBe(true);
    expect(deck.getKey(0, 0)).toMatchObject({ text: 'P2' });
  });

  it('still sends the release when the down acknowledgement times out', async () => {
    const { server, client, deck } = await setup(WRITE, { ignoreKeyPress: true });
    await expect(
      pressVerified(client, deck, 0, 0, { dryRun: false, ackTimeoutMs: 80, ...FAST }),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(keyPresses(server)).toEqual([
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=1',
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=0',
    ]);
  });
});

describe('press gate', () => {
  it('refuses without COMPANION_MCP_WRITE and sends nothing', async () => {
    const { server, client, deck } = await setup(READ_ONLY);
    await expect(
      pressVerified(client, deck, 0, 0, { dryRun: false, ...FAST }),
    ).rejects.toMatchObject({
      name: 'SafetyError',
      code: 'WRITE_DISABLED',
    });
    expect(keyPresses(server)).toEqual([]);
  });

  it('refuses a button that is not in COMPANION_MCP_PRESS_ALLOW', async () => {
    const { server, client, deck } = await setup(
      loadSafetyConfig({ COMPANION_MCP_WRITE: '1', COMPANION_MCP_PRESS_ALLOW: '1/0/1' }),
    );
    await expect(
      pressVerified(client, deck, 0, 0, { dryRun: false, ...FAST }),
    ).rejects.toMatchObject({
      code: 'PRESS_NOT_ALLOWED',
    });
    expect(keyPresses(server)).toEqual([]);
    const allowed = await pressVerified(client, deck, 0, 1, { dryRun: false, ...FAST });
    expect(allowed.sent).toBe(true);
  });

  it('the low-level client.keyPress is gated as well', async () => {
    const { server, client, deck } = await setup(READ_ONLY);
    await expect(
      client.keyPress(deck.deviceId, 0, true, { page: 1, row: 0, column: 0 }),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED' });
    expect(keyPresses(server)).toEqual([]);
  });
});

describe('dry run', () => {
  it('sends nothing and returns key, current content and gate status', async () => {
    const { server, client, deck } = await setup(READ_ONLY);
    const plan = await pressVerified(client, deck, 0, 0, { dryRun: true, ...FAST });
    expect(plan.dryRun).toBe(true);
    expect(plan.sent).toBe(false);
    expect(plan.key).toBe(0);
    expect(plan.location).toEqual({ page: 1, row: 0, column: 0 });
    expect(plan.current).toMatchObject({ text: 'SET', color: '#00ff00' });
    expect(plan.empty).toBe(false);
    expect(plan.locked).toBe(false);
    expect(plan.gate).toMatchObject({ allowed: false, code: 'WRITE_DISABLED' });
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(plan.wouldSend).toEqual([
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=1',
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=0',
    ]);
    expect(keyPresses(server)).toEqual([]);
  });

  it('reports an open gate and flags empty keys', async () => {
    const { client, deck } = await setup(WRITE);
    const plan = await planPress(client, deck, 2, 2, FAST);
    expect(plan.gate).toEqual({ allowed: true });
    expect(plan.empty).toBe(true);
  });

  it('reports a press-allow refusal as gate status without throwing', async () => {
    const { client, deck } = await setup(
      loadSafetyConfig({ COMPANION_MCP_WRITE: '1', COMPANION_MCP_PRESS_ALLOW: '1/0/1' }),
    );
    const plan = await planPress(client, deck, 0, 0, FAST);
    expect(plan.gate).toMatchObject({ allowed: false, code: 'PRESS_NOT_ALLOWED' });
  });
});

describe('read-before-press binding and lock', () => {
  it('refuses when the key changed since it was read (fingerprint mismatch)', async () => {
    const { server, client, deck } = await setup(WRITE);
    const plan = await planPress(client, deck, 0, 0, FAST);
    // an operator-side change: SET turns red through another press, then the old plan is stale
    await pressVerified(client, deck, 0, 0, { dryRun: false, ...FAST });
    const before = keyPresses(server).length;
    await expect(
      pressVerified(client, deck, 0, 0, {
        dryRun: false,
        expectFingerprint: plan.fingerprint,
        ...FAST,
      }),
    ).rejects.toMatchObject({ code: 'KEY_CHANGED' });
    expect(keyPresses(server)).toHaveLength(before);
  });

  it('accepts a matching fingerprint', async () => {
    const { client, deck } = await setup(WRITE);
    const plan = await planPress(client, deck, 0, 1, FAST);
    const result = await pressVerified(client, deck, 0, 1, {
      dryRun: false,
      expectFingerprint: plan.fingerprint,
      ...FAST,
    });
    expect(result.fingerprintBefore).toBe(plan.fingerprint);
  });

  it('refuses a locked surface instead of reporting success from the server OK', async () => {
    const { server, client } = await setup(WRITE, { locked: true }, false);
    const deck = client.devices[0] as VirtualDeck;
    expect(deck.locked).toBe(true);
    // no KEY-STATE while locked: nothing to read
    await expect(
      pressVerified(client, deck, 0, 0, { dryRun: false, quietMs: 20, snapshotTimeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_TIMEOUT' });
    expect(keyPresses(server)).toEqual([]);
  });

  it('refuses when LOCKED-STATE arrives while keys are known', async () => {
    const { server, client, deck } = await setup(WRITE);
    server.sessions[0]?.send(
      'LOCKED-STATE DEVICEID="mcp-virtual-deck" LOCKED=1 CHARACTER_COUNT=0 ROTATION=0',
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(
      pressVerified(client, deck, 0, 0, { dryRun: false, ...FAST }),
    ).rejects.toMatchObject({
      code: 'SURFACE_LOCKED',
    });
    expect(keyPresses(server)).toEqual([]);
    const plan = await planPress(client, deck, 0, 0, FAST);
    expect(plan.locked).toBe(true);
  });

  it('refuses a lock-icon key (surface locked without PINCODE_LOCK)', async () => {
    const { client, deck } = await setup(WRITE);
    const server = deck as unknown as { apply(m: unknown): boolean };
    server.apply({
      type: 'key-state',
      deviceId: deck.deviceId,
      key: 0,
      location: { page: 1, row: 0, column: 0 },
      pressed: false,
      keyType: 'BUTTON',
      bitmap: null,
      color: '#000000',
      textColor: '#ffffff',
      text: '\u{1F512}',
      fontSize: 'auto',
    });
    await expect(
      pressVerified(client, deck, 0, 0, { dryRun: false, ...FAST }),
    ).rejects.toMatchObject({
      code: 'SURFACE_LOCKED',
    });
  });

  it('reports KEY_NOT_FOUND for a location outside the deck', async () => {
    const { client, deck } = await setup(WRITE);
    await expect(
      pressVerified(client, deck, 9, 9, { dryRun: false, ...FAST }),
    ).rejects.toMatchObject({
      code: 'KEY_NOT_FOUND',
    });
    await expect(pressVerified(client, deck, -1, 0, { dryRun: true })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
