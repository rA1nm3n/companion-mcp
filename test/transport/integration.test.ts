import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSnapshot, planRollback, type JsonObject } from '../../src/safety/index.js';
import { CompanionTrpc, diffReadback, RestV2Client } from '../../src/transport/index.js';
import { buildTestPage, clone } from './fixtures.js';

/**
 * Runs only against a real Companion 5.1.x: `COMPANION_TEST_URL=http://127.0.0.1:8101 npm test`.
 * WARNING: this REPLACES page 1 of that instance and restores the original export afterwards, so point it at a
 * throw-away instance (fresh config directory), never at a production system.
 */
const url = process.env['COMPANION_TEST_URL'];

describe.skipIf(url === undefined)('integration against a real Companion', () => {
  const client = new CompanionTrpc();
  let snapshotPage1: JsonObject;

  beforeAll(async () => {
    await client.connect(url as string, { timeoutMs: 15_000, importTimeoutMs: 60_000 });
    snapshotPage1 = await client.exportPage(1);
  });

  afterAll(async () => {
    if (client.connected && snapshotPage1) {
      const snapshot = createSnapshot({
        host: 'integration',
        scope: { kind: 'page', page: 1 },
        exportFile: snapshotPage1,
      });
      for (const op of planRollback(snapshot).operations) {
        if (op.kind === 'import-page' && op.targetPage !== undefined) {
          await client.importPage({ exportFile: op.exportFile, targetPage: op.targetPage });
        }
      }
    }
    client.close();
  });

  it('reads a 5.1.x version', async () => {
    const version = await client.getVersion();
    expect(version.appVersion).toMatch(/^5\.1\.\d+/);
  });

  it('exports the full config and a page with file version 12 (measured)', async () => {
    const full = await client.exportFull();
    expect(full['type']).toBe('full');
    expect(full['version']).toBe(12);
    expect(snapshotPage1['type']).toBe('page');
  });

  it('imports a page, reads it back via tRPC and via export, and the diff is clean', async () => {
    const intended = buildTestPage({ text: 'ITEST' });
    const result = await client.importPage({ exportFile: intended, targetPage: 1 });
    expect(result.remapping).toBeTypeOf('object');

    const viaTrpc = await client.getPage(1);
    expect(viaTrpc.name).toBe('TESTPAGE');
    const trpcDiff = diffReadback(intended, viaTrpc as unknown as JsonObject);
    expect(trpcDiff.deviations.filter((d) => d.severity === 'error')).toEqual([]);

    const viaExport = await client.exportPage(1);
    const exportDiff = diffReadback(intended, viaExport);
    expect(exportDiff.deviations.filter((d) => d.severity === 'error')).toEqual([]);
    expect(exportDiff.summary.controlsMatched).toBe(1);
  });

  it('detects the silent drop of a legacy button in a version 17 file (measured trap)', async () => {
    const legacy = clone(buildTestPage());
    legacy['version'] = 17;
    const controls = (legacy['page'] as JsonObject)['controls'] as JsonObject;
    ((controls['0'] as JsonObject)['0'] as JsonObject)['type'] = 'button';
    await client.importPage({ exportFile: legacy, targetPage: 1 });
    const diff = diffReadback(legacy, await client.exportPage(1));
    expect(diff.ok).toBe(false);
    expect(diff.summary.controlsDropped).toBe(1);
  });

  it('restores the snapshot of page 1 by re-import', async () => {
    const snapshot = createSnapshot({
      host: 'integration',
      scope: { kind: 'page', page: 1 },
      exportFile: snapshotPage1,
    });
    const [op] = planRollback(snapshot).operations;
    await client.importPage({ exportFile: op!.exportFile, targetPage: 1 });
    const after = await client.exportPage(1);
    expect(diffReadback(snapshotPage1, after).ok).toBe(true);
  });

  it('reports a disabled REST API clearly (or serves OpenAPI when enabled)', async () => {
    const rest = new RestV2Client(url as string);
    const outcome = await rest.getOpenApi().then(
      (doc) => ({ doc }),
      (error: unknown) => ({ error }),
    );
    if ('error' in outcome) {
      expect(outcome.error).toMatchObject({ code: 'REST_DISABLED', status: 403 });
    } else {
      expect(outcome.doc['openapi']).toBeTypeOf('string');
    }
  });
});
