import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject, Snapshot } from '../../src/safety/index.js';
import { CompanionTrpc } from '../../src/transport/index.js';
import { buildTestPage } from '../transport/fixtures.js';
import { startHarness, type Harness } from './helpers/harness.js';

/**
 * Runs only against a real Companion 5.1.x:
 *
 *   COMPANION_TEST_URL=http://127.0.0.1:8000 COMPANION_TEST_SATELLITE_PORT=16622 npm test
 *
 * WARNING: replaces page 1 of that instance (restored afterwards) and the ATEM page adds a connection, so use a
 * throw-away instance. No real device is connected: the ATEM keys only exercise the plan and gate paths, a real
 * press happens only on a key with an Internal action (custom variable) that has a visible effect.
 * Verified with Companion 5.1.3.
 */
const url = process.env['COMPANION_TEST_URL'];
const satellitePort = Number(process.env['COMPANION_TEST_SATELLITE_PORT']);
const enabled = url !== undefined && Number.isInteger(satellitePort) && satellitePort > 0;

const READ = { port: satellitePort, quiet_ms: 400, timeout_ms: 10_000 };
const PRESS = { ...READ, change_timeout_ms: 3000 };

type KeyView = { row: number; column: number; text: string; color: string; empty: boolean };

describe.skipIf(!enabled)('satellite tools against a real Companion', () => {
  const trpc = new CompanionTrpc();
  let writer: Harness;
  let readOnly: Harness;
  let restricted: Harness;
  let snapshot: Snapshot | undefined;
  let original: JsonObject | undefined;

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
    const base = { COMPANION_URL: url as string };
    writer = await startHarness({ ...base, COMPANION_MCP_WRITE: '1' });
    readOnly = await startHarness(base);
    restricted = await startHarness({
      ...base,
      COMPANION_MCP_WRITE: '1',
      COMPANION_MCP_PRESS_ALLOW: '1/3/7',
    });
    await trpc.connect(url as string, { timeoutMs: 15_000, importTimeoutMs: 60_000 });
    original = await trpc.exportPage(1);
  }, 60_000);

  afterAll(async () => {
    if (trpc.connected) {
      if (original) await trpc.importPage({ exportFile: original, targetPage: 1 });
      trpc.close();
    }
    await Promise.all([writer?.close(), readOnly?.close(), restricted?.close()]);
  }, 30_000);

  it('ATEM template: import, snapshot of the rendered page, press only as plan and gate checks', async () => {
    const generated = await writer.call('generate_page', {
      template: 'atem',
      params: { connection: { label: 'atem' }, inputs: 4, pageName: 'MCP SATELLITE' },
    });
    expect(generated.body).toMatchObject({ ok: true, valid: true });

    // The import reads back without any compensation of the caller: connectionId remapping and children are
    // tolerated by the read-back diff itself.
    const applied = await writer.call('import_page', {
      config: generated.body['export'],
      target_page: 1,
      dry_run: false,
    });
    expect(applied.body).toMatchObject({
      ok: true,
      readback: { ok: true, summary: { controlsDropped: 0 } },
    });
    snapshot = applied.body['snapshot'] as Snapshot;

    const shot = await writer.call('satellite_snapshot', { ...READ, page_hint: 1 });
    expect(shot.body).toMatchObject({ ok: true, page: 1, complete: true });
    const keys = shot.body['keys'] as KeyView[];
    expect(keys).toHaveLength(32);
    const used = keys.filter((key) => !key.empty);
    expect(used.length).toBeGreaterThanOrEqual(4);
    const first = used[0] as KeyView;

    const plan = await writer.call('press', { row: first.row, column: first.column, ...READ });
    expect(plan.body).toMatchObject({
      ok: true,
      dry_run: true,
      sent: false,
      gate: { allowed: true },
      current: { text: first.text },
    });

    // Real presses on the ATEM page are refused by the gates; nothing reaches Companion.
    const noWrite = await readOnly.call('press', {
      row: first.row,
      column: first.column,
      dry_run: false,
      ...PRESS,
    });
    expect(noWrite.body).toMatchObject({ ok: false, code: 'WRITE_DISABLED' });
    const notListed = await restricted.call('press', {
      row: first.row,
      column: first.column,
      dry_run: false,
      ...PRESS,
    });
    expect(notListed.body).toMatchObject({ ok: false, code: 'PRESS_NOT_ALLOWED' });
  }, 90_000);

  it('Internal action page: a real press changes the render and the variable (independent check)', async () => {
    await trpc.importPage({ exportFile: buildTestPage({ text: 'ITEST' }), targetPage: 1 });
    await resetVariable();
    expect(await variable()).toBe('0');

    const plan = await writer.call('press', { row: 0, column: 0, ...READ });
    expect(plan.body).toMatchObject({ ok: true, sent: false, current: { text: 'ITEST' } });
    expect(await variable()).toBe('0');

    const empty = await writer.call('press', { row: 2, column: 5, dry_run: false, ...PRESS });
    expect(empty.body).toMatchObject({ ok: true, accepted: true, render_changed: false });
    expect(await variable()).toBe('0');

    const pressed = await writer.call('press', {
      row: 0,
      column: 0,
      dry_run: false,
      expect_fingerprint: plan.body['fingerprint'],
      ...PRESS,
    });
    expect(pressed.body).toMatchObject({
      ok: true,
      accepted: true,
      render_changed: true,
      target_changed: true,
      before: { color: '#00ff00' },
      after: { color: '#ff0000' },
    });
    expect(await variable()).toBe('42');

    // The button is red now: a press bound to the earlier green read is refused.
    const stale = await writer.call('press', {
      row: 0,
      column: 0,
      dry_run: false,
      expect_fingerprint: plan.body['fingerprint'],
      ...PRESS,
    });
    expect(stale.body).toMatchObject({ ok: false, code: 'KEY_CHANGED' });
    expect(await variable()).toBe('42');
    await resetVariable();
  }, 90_000);

  it('restores page 1 through the rollback of the ATEM import', async () => {
    expect(snapshot).toBeDefined();
    const done = await writer.call('rollback', { snapshot, dry_run: false });
    expect(done.body).toMatchObject({ ok: true });
  }, 60_000);
});
