import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../src/safety/index.js';
import { startHarness, type Harness } from './helpers/harness.js';

/**
 * Runs only against a real Companion 5.1.x: `COMPANION_TEST_URL=http://127.0.0.1:8210 npm test`.
 * WARNING: this REPLACES page 1 of that instance (and restores it by rollback), and importing the ATEM page
 * adds a connection. Point it at a throw-away instance with a fresh config directory.
 */
const url = process.env['COMPANION_TEST_URL'];

describe.skipIf(url === undefined)('tools against a real Companion', () => {
  let h: Harness;
  let snapshot: Snapshot | undefined;
  let originalName = '';

  beforeAll(async () => {
    h = await startHarness({ COMPANION_URL: url as string, COMPANION_MCP_WRITE: '1' });
  });

  afterAll(async () => {
    // Safety net: restore page 1 if a test failed between import and rollback.
    if (snapshot !== undefined && h !== undefined) {
      const current = await h.call('get_page', { page: 1 });
      if (current.body['name'] !== originalName) {
        await h.call('rollback', { snapshot, dry_run: false });
      }
    }
    await h?.close();
  });

  it('generate_page(atem) -> import_page (dry run, then applied) -> get_page -> rollback', async () => {
    const status = await h.call('status');
    expect(status.body).toMatchObject({
      ok: true,
      ready: true,
      companion: { versionSupported: true },
    });

    const before = await h.call('get_page', { page: 1 });
    expect(before.body.ok).toBe(true);
    originalName = String(before.body['name']);

    const generated = await h.call('generate_page', {
      template: 'atem',
      params: { connection: { label: 'atem' }, inputs: 4, pageName: 'MCP INTEGRATION' },
    });
    expect(generated.body).toMatchObject({ ok: true, valid: true });
    const config = generated.body['export'];

    const dry = await h.call('import_page', { config, target_page: 1 });
    expect(dry.body).toMatchObject({ ok: true, dry_run: true, plan: { wouldBeAllowed: true } });
    expect((await h.call('get_page', { page: 1 })).body['name']).toBe(originalName);

    const applied = await h.call('import_page', { config, target_page: 1, dry_run: false });
    expect(applied.body).toMatchObject({
      ok: true,
      readback: { ok: true, summary: { controlsDropped: 0 } },
    });
    snapshot = applied.body['snapshot'] as Snapshot;

    const after = await h.call('get_page', { page: 1 });
    expect(after.body).toMatchObject({ ok: true, name: 'MCP INTEGRATION' });
    expect(after.body['controlCount'] as number).toBeGreaterThanOrEqual(8);

    const plan = await h.call('rollback', { snapshot });
    expect(plan.body).toMatchObject({ ok: true, dry_run: true, checksum_valid: true });
    const rolledBack = await h.call('rollback', { snapshot, dry_run: false });
    expect(rolledBack.body).toMatchObject({ ok: true, readback: { ok: true } });
    expect((await h.call('get_page', { page: 1 })).body['name']).toBe(originalName);
  });
});
