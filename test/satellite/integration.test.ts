import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSafetyConfig, type JsonObject } from '../../src/safety/index.js';
import { pressVerified, SatelliteClient, type VirtualDeck } from '../../src/satellite/index.js';
import { CompanionTrpc } from '../../src/transport/index.js';
import { buildTestPage } from '../transport/fixtures.js';

/**
 * Runs only against a real Companion 5.1.x:
 *
 *   COMPANION_TEST_URL=http://127.0.0.1:8000 COMPANION_TEST_SATELLITE_PORT=16622 npm test
 *
 * WARNING: this REPLACES page 1 of that instance (and restores it afterwards), creates a Satellite surface
 * "mcp-itest" and presses a button, so point it at a throw-away instance (fresh config directory).
 * Verified with Companion 5.1.3 (see docs/satellite.md).
 */
const url = process.env['COMPANION_TEST_URL'];
const satellitePort = Number(process.env['COMPANION_TEST_SATELLITE_PORT']);
const enabled = url !== undefined && Number.isInteger(satellitePort) && satellitePort > 0;

const FAST = { quietMs: 250, changeTimeoutMs: 3000, snapshotTimeoutMs: 10_000 };

describe.skipIf(!enabled)('Satellite client against a real Companion', () => {
  const trpc = new CompanionTrpc();
  const host = enabled ? new URL(url as string).hostname : '127.0.0.1';
  const safety = loadSafetyConfig({
    COMPANION_MCP_WRITE: '1',
    COMPANION_MCP_ALLOWED_HOSTS: host,
  });
  const client = new SatelliteClient({ safety });
  let original: JsonObject | undefined;
  let deck: VirtualDeck;
  let greenFingerprint = '';

  async function variable(): Promise<string> {
    const response = await fetch(`${url}/api/custom-variable/mytest/value`);
    return response.status === 200 ? await response.text() : `HTTP ${response.status}`;
  }

  async function resetVariable(): Promise<void> {
    try {
      await trpc.mutation('customVariables.create', { name: 'mytest', defaultVal: '0' });
    } catch {
      // exists already
    }
    await trpc.mutation('customVariables.setCurrent', { name: 'mytest', value: '0' });
  }

  beforeAll(async () => {
    await trpc.connect(url as string, { timeoutMs: 15_000, importTimeoutMs: 60_000 });
    original = await trpc.exportPage(1);
    await trpc.importPage({ exportFile: buildTestPage({ text: 'ITEST' }), targetPage: 1 });
    await resetVariable();
    const info = await client.connect(host, satellitePort, { timeoutMs: 10_000 });
    expect(info.apiVersion).toMatch(/^1\./);
    deck = await client.addDevice({ deviceId: 'mcp-itest', productName: 'companion-mcp itest' });
  }, 60_000);

  afterAll(async () => {
    await client.close();
    if (trpc.connected) {
      if (original) {
        await trpc.importPage({ exportFile: original, targetPage: 1 });
      }
      trpc.close();
    }
  }, 30_000);

  it('negotiates API 1.x and registers a virtual 8x4 deck', () => {
    expect(client.state).toBe('ready');
    expect(client.info?.companionVersion).toMatch(/^5\.1\./);
    expect(deck.keysTotal).toBe(32);
    expect(deck.rows).toBe(4);
  });

  it('snapshotPage returns the imported page: complete grid on page 1 with the test button', async () => {
    const snapshot = await deck.snapshotPage({ page: 1, quietMs: 400, timeoutMs: 10_000 });
    expect(snapshot.page).toBe(1);
    expect(snapshot.cells).toHaveLength(32);
    expect(snapshot.complete).toBe(true);
    const key = deck.getKey(0, 0);
    expect(key?.text).toBe('ITEST');
    expect(key?.color).toBe('#00ff00');
    expect(key?.location).toEqual({ page: 1, row: 0, column: 0 });
    // an unused key is empty
    expect(deck.getKey(2, 5)).toMatchObject({ text: '' });
  }, 20_000);

  it('dry run sends nothing and shows the plan', async () => {
    expect(await variable()).toBe('0');
    const plan = await pressVerified(client, deck, 0, 0, { dryRun: true, ...FAST });
    greenFingerprint = plan.fingerprint;
    expect(plan.sent).toBe(false);
    expect(plan.current.text).toBe('ITEST');
    expect(plan.gate).toEqual({ allowed: true });
    expect(plan.wouldSend[0]).toBe('KEY-PRESS DEVICEID="mcp-itest" KEY=0 PRESSED=1');
    expect(await variable()).toBe('0');
  }, 20_000);

  it('the gate refuses a client without the write flag, nothing is pressed', async () => {
    const readOnly = new SatelliteClient({
      safety: loadSafetyConfig({ COMPANION_MCP_ALLOWED_HOSTS: host }),
    });
    await readOnly.connect(host, satellitePort, { timeoutMs: 10_000 });
    try {
      const other = await readOnly.addDevice({ deviceId: 'mcp-itest-ro' });
      await other.snapshotPage({ quietMs: 400, timeoutMs: 10_000 });
      await expect(
        pressVerified(readOnly, other, 0, 0, { dryRun: false, ...FAST }),
      ).rejects.toMatchObject({ code: 'WRITE_DISABLED' });
      expect(await variable()).toBe('0');
    } finally {
      await readOnly.close();
    }
  }, 30_000);

  it('empty key: Companion answers OK but nothing changes, renderChanged is false', async () => {
    const result = await pressVerified(client, deck, 2, 5, { dryRun: false, ...FAST });
    expect(result.sent).toBe(true);
    expect(result.renderChanged).toBe(false);
    expect(result.level).toBe('accepted');
    expect(await variable()).toBe('0');
  }, 20_000);

  it('press on the test button: render changes via feedback and the variable is set (independent check)', async () => {
    const result = await pressVerified(client, deck, 0, 0, { dryRun: false, ...FAST });
    expect(result.sent).toBe(true);
    expect(result.renderChanged).toBe(true);
    expect(result.targetChanged).toBe(true);
    expect(result.before.color).toBe('#00ff00');
    expect(result.after?.color).toBe('#ff0000');
    expect(result.after?.pressed).toBe(false);
    expect(await variable()).toBe('42');
  }, 20_000);

  it('a press bound to the earlier (green) read is refused now that the button is red', async () => {
    await expect(
      pressVerified(client, deck, 0, 0, {
        dryRun: false,
        expectFingerprint: greenFingerprint,
        ...FAST,
      }),
    ).rejects.toMatchObject({ code: 'KEY_CHANGED' });
    expect(await variable()).toBe('42');
    await resetVariable();
  }, 20_000);

  it('removes the device and closes cleanly', async () => {
    await client.removeDevice('mcp-itest');
    expect(client.devices).toHaveLength(0);
    await client.close();
    expect(client.state).toBe('disconnected');
  }, 20_000);
});
