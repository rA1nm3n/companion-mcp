import { afterEach, describe, expect, it } from 'vitest';
import { MockSatelliteServer, type MockOptions } from '../satellite/mock-server.js';
import { startHarness, type Harness } from './helpers/harness.js';

const SNAP = { quiet_ms: 40, timeout_ms: 1500 };
const FAST = { ...SNAP, change_timeout_ms: 300 };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup(
  env: Record<string, string> = {},
  mockOptions: MockOptions = {},
): Promise<{ h: Harness; mock: MockSatelliteServer }> {
  const mock = new MockSatelliteServer(mockOptions);
  await mock.start();
  const h = await startHarness({ COMPANION_URL: 'http://127.0.0.1:8000', ...env });
  cleanup.push(async () => {
    await h.close();
    await mock.stop();
  });
  return { h, mock };
}

const WRITE = { COMPANION_MCP_WRITE: '1' };
const keyPresses = (mock: MockSatelliteServer): string[] =>
  mock.received.filter((line) => line.startsWith('KEY-PRESS'));

type KeyView = {
  row: number;
  column: number;
  text: string;
  color: string;
  fingerprint: string;
  bitmap?: { format: string; base64: string };
};

describe('companion_satellite_snapshot', () => {
  it('returns the grid of page 1 and closes cleanly without pressing anything', async () => {
    const { h, mock } = await setup();
    const { body, isError } = await h.call('satellite_snapshot', { port: mock.port, ...SNAP });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      ok: true,
      page: 1,
      complete: true,
      locked: false,
      deck: { keys_total: 32, keys_per_row: 8, rows: 4 },
    });
    const keys = body['keys'] as KeyView[];
    expect(keys).toHaveLength(32);
    expect(keys.find((k) => k.row === 0 && k.column === 0)).toMatchObject({
      text: 'SET',
      color: '#00ff00',
    });
    expect(keys.find((k) => k.row === 2 && k.column === 5)).toMatchObject({
      text: '',
      empty: true,
    });
    expect(keys.every((k) => k.bitmap === undefined)).toBe(true);
    expect(typeof keys[0]?.fingerprint).toBe('string');
    expect(String(body['note'])).toContain('page 1');
    expect(mock.received.some((line) => line.startsWith('ADD-DEVICE'))).toBe(true);
    expect(mock.received.some((line) => line.includes('BITMAPS='))).toBe(false);
    expect(keyPresses(mock)).toEqual([]);
    expect(mock.commands).toContain('REMOVE-DEVICE');
    expect(mock.commands.at(-1)).toBe('QUIT');
  });

  it('works without the write gate (read only) and honours a custom deck geometry', async () => {
    const { h, mock } = await setup();
    const { body } = await h.call('satellite_snapshot', {
      port: mock.port,
      deck: { keys_total: 15, keys_per_row: 5 },
      ...SNAP,
    });
    expect(body).toMatchObject({ ok: true, deck: { keys_total: 15, keys_per_row: 5, rows: 3 } });
    expect(body['keys']).toHaveLength(15);
  });

  it('adds bitmaps (base64 plus format) only on request', async () => {
    const { h, mock } = await setup();
    const { body } = await h.call('satellite_snapshot', {
      port: mock.port,
      include_bitmaps: true,
      ...SNAP,
    });
    expect(body['ok']).toBe(true);
    const first = (body['keys'] as KeyView[])[0];
    expect(first?.bitmap?.format).toBe('png');
    expect(first?.bitmap?.base64.length).toBeGreaterThan(0);
    expect(mock.received.some((line) => line.includes('BITMAPS='))).toBe(true);
  });

  it('refuses a host that is not on the allow-list before any connection is made', async () => {
    const { h, mock } = await setup();
    const { body, isError } = await h.call('satellite_snapshot', {
      host: '192.0.2.1',
      port: mock.port,
      ...SNAP,
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'HOST_NOT_ALLOWED', source: 'safety' });
    expect(mock.sessions).toHaveLength(0);
  });

  it('reports a timeout as ok:false with the satellite code (no KEY-STATE arrives)', async () => {
    const { h, mock } = await setup({}, { locked: true });
    const { body, isError } = await h.call('satellite_snapshot', {
      port: mock.port,
      quiet_ms: 40,
      timeout_ms: 300,
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'SNAPSHOT_TIMEOUT', source: 'satellite' });
    expect(mock.commands.at(-1)).toBe('QUIT');
  });

  it('reports a connection that never answers with BEGIN', async () => {
    const { h, mock } = await setup({}, { silent: true });
    const { body } = await h.call('satellite_snapshot', {
      port: mock.port,
      quiet_ms: 40,
      timeout_ms: 300,
    });
    expect(body).toMatchObject({ ok: false, source: 'satellite' });
    expect(['HANDSHAKE_TIMEOUT', 'CONNECT_TIMEOUT']).toContain(body['code']);
  });

  it('rejects invalid input through the schema (plain text, not a tool body)', async () => {
    const { h } = await setup();
    const bad: Array<Record<string, unknown>> = [
      { unknown_key: 1 },
      { port: 0 },
      { timeout_ms: 5 },
      { deck: { keys_total: 4, keys_per_row: 8 } },
      { deck: { keys_total: 32, extra: true } },
    ];
    for (const args of bad) {
      const result = await h.client.callTool({
        name: 'companion_satellite_snapshot',
        arguments: args,
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(text).not.toContain('"ok": true');
    }
  });
});

describe('companion_press', () => {
  it('dry run is the default: it sends no KEY-PRESS and returns the plan', async () => {
    const { h, mock } = await setup(WRITE);
    const { body, isError } = await h.call('press', {
      row: 0,
      column: 0,
      port: mock.port,
      ...FAST,
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      sent: false,
      location: { page: 1, row: 0, column: 0 },
      current: { text: 'SET', color: '#00ff00' },
      empty: false,
      gate: { allowed: true },
      would_be_allowed: true,
      fingerprint_matches: null,
    });
    expect(body['would_send']).toEqual([
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=1',
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=0',
    ]);
    expect(keyPresses(mock)).toEqual([]);
  });

  it('dry run shows a closed write gate and still sends nothing', async () => {
    const { h, mock } = await setup();
    const { body } = await h.call('press', { row: 0, column: 0, port: mock.port, ...FAST });
    expect(body).toMatchObject({
      ok: true,
      sent: false,
      gate: { allowed: false, code: 'WRITE_DISABLED' },
      would_be_allowed: false,
    });
    expect(keyPresses(mock)).toEqual([]);
  });

  it('a real press without COMPANION_MCP_WRITE is WRITE_DISABLED and never connects', async () => {
    const { h, mock } = await setup();
    const { body, isError } = await h.call('press', {
      row: 0,
      column: 0,
      dry_run: false,
      port: mock.port,
      ...FAST,
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'WRITE_DISABLED', source: 'safety' });
    expect(mock.sessions).toHaveLength(0);
    expect(keyPresses(mock)).toEqual([]);
  });

  it('refuses a host that is not on the allow-list, also for a dry run', async () => {
    const { h, mock } = await setup(WRITE);
    for (const dry_run of [true, false]) {
      const { body } = await h.call('press', {
        row: 0,
        column: 0,
        dry_run,
        host: '192.0.2.1',
        port: mock.port,
        ...FAST,
      });
      expect(body).toMatchObject({ ok: false, code: 'HOST_NOT_ALLOWED' });
    }
    expect(mock.sessions).toHaveLength(0);
  });

  it('enforces the press allow-list (dry run shows it, a real press is refused, a listed key works)', async () => {
    const { h, mock } = await setup({ ...WRITE, COMPANION_MCP_PRESS_ALLOW: '1/0/1' });
    const plan = await h.call('press', { row: 0, column: 0, port: mock.port, ...FAST });
    expect(plan.body).toMatchObject({
      ok: true,
      gate: { allowed: false, code: 'PRESS_NOT_ALLOWED' },
      would_be_allowed: false,
    });
    const refused = await h.call('press', {
      row: 0,
      column: 0,
      dry_run: false,
      port: mock.port,
      ...FAST,
    });
    expect(refused.body).toMatchObject({ ok: false, code: 'PRESS_NOT_ALLOWED', source: 'safety' });
    expect(keyPresses(mock)).toEqual([]);
    const allowed = await h.call('press', {
      row: 0,
      column: 1,
      dry_run: false,
      port: mock.port,
      ...FAST,
    });
    expect(allowed.body).toMatchObject({
      ok: true,
      sent: true,
      location: { page: 1, row: 0, column: 1 },
    });
    expect(keyPresses(mock)).toHaveLength(2);
  });

  it('presses SET: accepted, render_changed, target_changed with before/after and all changes', async () => {
    const { h, mock } = await setup(WRITE);
    const { body, isError } = await h.call('press', {
      row: 0,
      column: 0,
      dry_run: false,
      port: mock.port,
      ...FAST,
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      ok: true,
      sent: true,
      accepted: true,
      level: 'render_changed',
      render_changed: true,
      target_changed: true,
      page_changed: false,
      before: { text: 'SET', color: '#00ff00' },
      after: { text: 'SET', color: '#ff0000' },
    });
    const changes = body['changes'] as Array<{ row: number; column: number }>;
    expect(changes.map((c) => [c.row, c.column])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(String(body['note'])).toContain('verify it independently');
    expect(keyPresses(mock)).toEqual([
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=1',
      'KEY-PRESS DEVICEID="mcp-virtual-deck" KEY=0 PRESSED=0',
    ]);
    expect(mock.commands.at(-1)).toBe('QUIT');
  });

  it('an empty key is accepted but shows no render change (OK is no proof)', async () => {
    const { h, mock } = await setup(WRITE);
    const { body } = await h.call('press', {
      row: 3,
      column: 5,
      dry_run: false,
      port: mock.port,
      ...FAST,
    });
    expect(body).toMatchObject({
      ok: true,
      accepted: true,
      level: 'accepted',
      render_changed: false,
      target_changed: false,
      page_changed: false,
      changes: [],
    });
    expect(keyPresses(mock)).toHaveLength(2);
  });

  it('reports a page change when the pressed key is a navigation key', async () => {
    const { h, mock } = await setup(WRITE);
    const { body } = await h.call('press', {
      row: 1,
      column: 0,
      dry_run: false,
      port: mock.port,
      ...FAST,
    });
    expect(body).toMatchObject({ ok: true, render_changed: true, page_changed: true });
  });

  it('binds a press to a fingerprint: the one from a snapshot passes, a stale one is KEY_CHANGED', async () => {
    const { h, mock } = await setup(WRITE);
    const snapshot = await h.call('satellite_snapshot', { port: mock.port, ...SNAP });
    const key = (snapshot.body['keys'] as KeyView[]).find((k) => k.row === 0 && k.column === 0);
    const dry = await h.call('press', {
      row: 0,
      column: 0,
      expect_fingerprint: key?.fingerprint as string,
      port: mock.port,
      ...FAST,
    });
    expect(dry.body).toMatchObject({
      ok: true,
      fingerprint: key?.fingerprint,
      fingerprint_matches: true,
    });

    const stale = await h.call('press', {
      row: 0,
      column: 0,
      dry_run: false,
      expect_fingerprint: 'stale-fingerprint',
      port: mock.port,
      ...FAST,
    });
    expect(stale.body).toMatchObject({ ok: false, code: 'KEY_CHANGED', source: 'satellite' });
    expect(keyPresses(mock)).toEqual([]);

    const fresh = await h.call('press', {
      row: 0,
      column: 0,
      dry_run: false,
      expect_fingerprint: key?.fingerprint as string,
      port: mock.port,
      ...FAST,
    });
    expect(fresh.body).toMatchObject({ ok: true, render_changed: true });
  });

  it('a fingerprint from a snapshot with bitmaps also matches', async () => {
    const { h, mock } = await setup(WRITE);
    const snapshot = await h.call('satellite_snapshot', {
      port: mock.port,
      include_bitmaps: true,
      ...SNAP,
    });
    const key = (snapshot.body['keys'] as KeyView[]).find((k) => k.row === 0 && k.column === 0);
    const dry = await h.call('press', {
      row: 0,
      column: 0,
      expect_fingerprint: key?.fingerprint as string,
      port: mock.port,
      ...FAST,
    });
    expect(dry.body).toMatchObject({ fingerprint_matches: true });
  });

  it('a key outside the virtual deck is KEY_NOT_FOUND', async () => {
    const { h, mock } = await setup(WRITE);
    const { body } = await h.call('press', { row: 9, column: 0, port: mock.port, ...FAST });
    expect(body).toMatchObject({ ok: false, code: 'KEY_NOT_FOUND', source: 'satellite' });
  });

  it('reports a timeout as ok:false and presses nothing', async () => {
    const { h, mock } = await setup(WRITE, { locked: true });
    const { body, isError } = await h.call('press', {
      row: 0,
      column: 0,
      dry_run: false,
      port: mock.port,
      quiet_ms: 40,
      timeout_ms: 300,
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'SNAPSHOT_TIMEOUT', source: 'satellite' });
    expect(keyPresses(mock)).toEqual([]);
  });

  it('rejects invalid input through the schema', async () => {
    const { h } = await setup(WRITE);
    const bad: Array<Record<string, unknown>> = [
      {},
      { row: -1, column: 0 },
      { row: 0, column: 1.5 },
      { row: 0, column: 0, dry_run: 'no' },
      { row: 0, column: 0, surprise: true },
    ];
    for (const args of bad) {
      const result = await h.client.callTool({ name: 'companion_press', arguments: args });
      expect(result.isError).toBe(true);
    }
  });

  it('serializes concurrent calls that share the device id', async () => {
    const { h, mock } = await setup();
    const results = await Promise.all([
      h.call('satellite_snapshot', { port: mock.port, ...SNAP }),
      h.call('satellite_snapshot', { port: mock.port, ...SNAP }),
    ]);
    expect(results.map((r) => r.body['ok'])).toEqual([true, true]);
  });
});
