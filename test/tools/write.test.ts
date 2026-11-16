import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifySnapshot, type Snapshot } from '../../src/safety/index.js';
import { startFakeCompanion, type FakeCompanion } from './helpers/fake-companion.js';
import { envFor, startHarness, type Harness } from './helpers/harness.js';
import { atemPage } from './helpers/pages.js';

let fake: FakeCompanion;
let h: Harness | undefined;

const WRITE = { COMPANION_MCP_WRITE: '1' };

async function start(extra: Record<string, string> = {}): Promise<Harness> {
  h = await startHarness(envFor(fake.url, extra));
  return h;
}

function importPaths(): string[] {
  return fake.server.calls.filter((c) => c.path.startsWith('importExport.')).map((c) => c.path);
}

beforeEach(async () => {
  fake = await startFakeCompanion();
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  await fake.close();
});

describe('import_page: dry run and gates', () => {
  it('defaults to a dry run: returns the plan and makes no call at all', async () => {
    const harness = await start(WRITE);
    const page = await atemPage(harness.call);
    const { body, isError } = await harness.call('import_page', { config: page, target_page: 1 });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      plan: { dryRun: true, wouldBeAllowed: true, blockedBy: [], host: '127.0.0.1' },
    });
    const kinds = (body['plan'] as { operations: Array<{ kind: string }> }).operations.map(
      (o) => o.kind,
    );
    expect(kinds).toEqual(['snapshot', 'import-page', 'readback']);
    expect(fake.server.calls).toEqual([]);
    expect(fake.pages[0]?.name).toBe('Original');
  });

  it('a dry run shows what blocks the real run (write gate off)', async () => {
    const harness = await start();
    const page = await atemPage(harness.call);
    const { body } = await harness.call('import_page', {
      config: page,
      target_page: -1,
      dry_run: true,
    });
    expect(body).toMatchObject({
      ok: true,
      plan: { wouldBeAllowed: false, blockedBy: ['WRITE_DISABLED'] },
    });
    expect((body['plan'] as { warnings: string[] }).warnings.join(' ')).toContain('Appending');
    expect(fake.server.calls).toEqual([]);
  });

  it('refuses dry_run=false while the write gate is off (default) and sends nothing', async () => {
    const harness = await start();
    const page = await atemPage(harness.call);
    const { body, isError } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'WRITE_DISABLED', source: 'safety' });
    expect(fake.server.calls).toEqual([]);
    expect(fake.pages[0]?.name).toBe('Original');
  });

  it('refuses a host that is not on the allow-list, even as a dry run', async () => {
    const harness = await start({ ...WRITE, COMPANION_MCP_ALLOWED_HOSTS: 'other.example' });
    const page = await atemPage(harness.call);
    for (const dry_run of [true, false]) {
      const { body } = await harness.call('import_page', { config: page, target_page: 1, dry_run });
      expect(body).toMatchObject({ ok: false, code: 'HOST_NOT_ALLOWED' });
    }
    expect(fake.server.calls).toEqual([]);
  });

  it('aborts on validation errors before anything else (legacy button, version 17)', async () => {
    const harness = await start(WRITE);
    const page = JSON.parse(JSON.stringify(await atemPage(harness.call)));
    page.version = 17;
    page.page.controls['0']['0'].type = 'button';
    const { body } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
    });
    expect(body).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', source: 'validation' });
    expect((body['errors'] as unknown[]).length).toBeGreaterThan(0);
    expect(fake.server.calls).toEqual([]);
  });

  it('rejects other export types and invalid target pages', async () => {
    const harness = await start(WRITE);
    const full = {
      version: 12,
      type: 'full',
      pages: {},
      instances: {},
      triggers: {},
      triggerCollections: [],
    };
    expect(
      (await harness.call('import_page', { config: full, target_page: 1 })).body,
    ).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_EXPORT_TYPE',
    });
    const page = await atemPage(harness.call);
    for (const target_page of [0, -2, 1.5]) {
      const result = await harness.client.callTool({
        name: 'companion_import_page',
        arguments: { config: page, target_page },
      });
      expect(result.isError).toBe(true);
    }
  });

  it('warns about connection_mapping keys that are not in the file', async () => {
    const harness = await start(WRITE);
    const page = await atemPage(harness.call);
    const { body } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      connection_mapping: { ghost: 'abc' },
    });
    expect((body['plan'] as { warnings: string[] }).warnings.join(' ')).toContain('ghost');
  });
});

describe('import_page: applied', () => {
  it('imports, reads back and returns a verified snapshot and a rollback hint', async () => {
    const harness = await start(WRITE);
    const page = await atemPage(harness.call, 'NEW PAGE');
    const { body, isError } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      ok: true,
      dry_run: false,
      target_page: 1,
      appended: false,
      readback: { ok: true, summary: { controlsDropped: 0 } },
    });
    expect(body['rollback']).toContain('companion_rollback');
    const snapshot = body['snapshot'] as Snapshot;
    expect(snapshot).toMatchObject({
      host: '127.0.0.1',
      scope: { kind: 'page', page: 1 },
      companionVersion: '5.1.3',
    });
    expect(snapshot.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySnapshot(snapshot)).toBe(true);
    expect((snapshot.exportFile['page'] as { name: string }).name).toBe('Original');

    expect(fake.pages[0]?.name).toBe('NEW PAGE');
    // The import steps share one connection (measured Companion requirement).
    const importConnections = new Set(
      fake.server.calls.filter((c) => c.path.startsWith('importExport.')).map((c) => c.connection),
    );
    expect(importConnections.size).toBe(1);
    expect(importPaths()).toEqual([
      'importExport.prepareImport.start',
      'importExport.prepareImport.uploadChunk',
      'importExport.prepareImport.complete',
      'importExport.importSinglePage',
    ]);
  });

  it('appends with target_page -1: no snapshot, resolved page number, rollback hint says delete', async () => {
    const harness = await start(WRITE);
    const page = await atemPage(harness.call, 'APPENDED');
    const { body } = await harness.call('import_page', {
      config: page,
      target_page: -1,
      dry_run: false,
    });
    expect(body).toMatchObject({ ok: true, target_page: 2, appended: true, snapshot: null });
    expect(body['rollback']).toContain('delete the page');
    expect(fake.pages).toHaveLength(2);
    expect(fake.pages[1]?.name).toBe('APPENDED');
  });

  it('treats silently dropped controls as a failure and still returns the snapshot', async () => {
    const harness = await start(WRITE);
    fake.dropTypes.add('button-layered');
    const page = await atemPage(harness.call);
    const { body, isError } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({
      ok: false,
      code: 'READBACK_MISMATCH',
      readback: { ok: false },
    });
    const readback = body['readback'] as {
      summary: { controlsDropped: number };
      deviations: Array<{ kind: string }>;
    };
    expect(readback.summary.controlsDropped).toBeGreaterThan(0);
    expect(readback.deviations.some((d) => d.kind === 'control-dropped')).toBe(true);
    expect(verifySnapshot(body['snapshot'] as Snapshot)).toBe(true);
  });

  it('returns the snapshot when the import itself fails', async () => {
    const harness = await start(WRITE);
    const page = await atemPage(harness.call);
    fake.failNext('importExport.importSinglePage', 'boom');
    const { body } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
    });
    expect(body).toMatchObject({ ok: false, code: 'REMOTE_ERROR', import_attempted: true });
    expect(verifySnapshot(body['snapshot'] as Snapshot)).toBe(true);
    expect(String(body['hint'])).toContain('companion_get_page');
  });

  it('fails without import when the target page does not exist (snapshot export fails)', async () => {
    const harness = await start(WRITE);
    const page = await atemPage(harness.call);
    const { body } = await harness.call('import_page', {
      config: page,
      target_page: 7,
      dry_run: false,
    });
    expect(body).toMatchObject({ ok: false, import_attempted: false, snapshot: null });
    expect(importPaths()).toEqual([]);
  });

  it('refuses an unsupported Companion version before any write', async () => {
    await fake.close();
    fake = await startFakeCompanion({ version: '6.0.0' });
    const harness = await start(WRITE);
    const page = await atemPage(harness.call);
    const { body } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
    });
    expect(body).toMatchObject({ ok: false, code: 'VERSION_UNSUPPORTED' });
    expect(importPaths()).toEqual([]);
  });

  it('serializes parallel imports: one upload session at a time, never interleaved', async () => {
    const harness = await start(WRITE);
    fake.uploadDelayMs.value = 40;
    const a = await atemPage(harness.call, 'A');
    const b = await atemPage(harness.call, 'B');
    const [ra, rb] = await Promise.all([
      harness.call('import_page', { config: a, target_page: -1, dry_run: false }),
      harness.call('import_page', { config: b, target_page: -1, dry_run: false }),
    ]);
    expect(ra.body.ok).toBe(true);
    expect(rb.body.ok).toBe(true);
    expect(fake.maxOpenSessions()).toBe(1);
    const sequence = fake.server.calls
      .filter((c) => c.path.startsWith('importExport.'))
      .map((c) => c.connection);
    const changes = sequence.filter((value, index) => index > 0 && value !== sequence[index - 1]);
    expect(changes).toHaveLength(1);
    expect(fake.pages.map((p) => p.name).sort()).toEqual(['A', 'B', 'Original']);
  });
});

describe('rollback', () => {
  async function importAndGetSnapshot(harness: Harness): Promise<Snapshot> {
    const page = await atemPage(harness.call, 'CHANGED');
    const { body } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
    });
    expect(body.ok).toBe(true);
    return body['snapshot'] as Snapshot;
  }

  it('dry run verifies the checksum and returns the plan without any call', async () => {
    const harness = await start(WRITE);
    const snapshot = await importAndGetSnapshot(harness);
    fake.server.calls.length = 0;
    const { body } = await harness.call('rollback', { snapshot });
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      checksum_valid: true,
      plan: { wouldBeAllowed: true },
    });
    expect(fake.server.calls).toEqual([]);
    expect(fake.pages[0]?.name).toBe('CHANGED');
  });

  it('restores the page by re-import, verifies by read-back and returns a pre-rollback snapshot', async () => {
    const harness = await start(WRITE);
    const snapshot = await importAndGetSnapshot(harness);
    const { body, isError } = await harness.call('rollback', { snapshot, dry_run: false });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, target_page: 1, readback: { ok: true } });
    expect(fake.pages[0]?.name).toBe('Original');
    const before = body['pre_rollback_snapshot'] as Snapshot;
    expect(verifySnapshot(before)).toBe(true);
    expect((before.exportFile['page'] as { name: string }).name).toBe('CHANGED');
  });

  it('refuses a manipulated snapshot (checksum mismatch), also as a dry run', async () => {
    const harness = await start(WRITE);
    const snapshot = JSON.parse(JSON.stringify(await importAndGetSnapshot(harness)));
    snapshot.exportFile.page.name = 'TAMPERED';
    fake.server.calls.length = 0;
    for (const dry_run of [true, false]) {
      const { body, isError } = await harness.call('rollback', { snapshot, dry_run });
      expect(isError).toBe(true);
      expect(body).toMatchObject({ ok: false, code: 'SNAPSHOT_INVALID', source: 'safety' });
    }
    expect(fake.server.calls).toEqual([]);
    expect(fake.pages[0]?.name).toBe('CHANGED');
  });

  it('refuses a snapshot taken on another host and a structurally invalid snapshot', async () => {
    const harness = await start(WRITE);
    const snapshot = await importAndGetSnapshot(harness);
    const foreign = { ...snapshot, host: 'other.example' };
    expect(
      (await harness.call('rollback', { snapshot: foreign, dry_run: false })).body,
    ).toMatchObject({
      ok: false,
      code: 'SNAPSHOT_HOST_MISMATCH',
    });
    const broken = await harness.client.callTool({
      name: 'companion_rollback',
      arguments: { snapshot: { checksum: 'x' } },
    });
    expect(broken.isError).toBe(true);
  });

  it('is refused while the write gate is off', async () => {
    const harness = await start(WRITE);
    const snapshot = await importAndGetSnapshot(harness);
    await harness.close();
    const gated = await start();
    fake.server.calls.length = 0;
    const { body } = await gated.call('rollback', { snapshot, dry_run: false });
    expect(body).toMatchObject({ ok: false, code: 'WRITE_DISABLED' });
    expect(fake.server.calls).toEqual([]);
    expect(fake.pages[0]?.name).toBe('CHANGED');
  });

  it('refuses a full-scope snapshot', async () => {
    const harness = await start(WRITE);
    const { createSnapshot } = await import('../../src/safety/index.js');
    const full = createSnapshot({
      host: '127.0.0.1',
      scope: { kind: 'full' },
      exportFile: { version: 12, type: 'full' },
    });
    const { body } = await harness.call('rollback', { snapshot: full, dry_run: false });
    expect(body).toMatchObject({ ok: false, code: 'UNSUPPORTED_SNAPSHOT_SCOPE' });
  });
});

describe('connections created by an import', () => {
  it('warns in the dry run, reports the created connection, and verifies despite the id remapping', async () => {
    const harness = await start(WRITE);
    const page = await atemPage(harness.call, 'WITH CONNECTION');
    const dry = await harness.call('import_page', { config: page, target_page: 1 });
    expect((dry.body['plan'] as { warnings: string[] }).warnings.join(' ')).toContain(
      'NEW connection',
    );

    const { body } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
    });
    // Measured on 5.1.3: connectionId is remapped and empty `children` of module entities are not stored;
    // the read-back must not report those as errors.
    expect(body).toMatchObject({ ok: true, readback: { ok: true } });
    expect(body['created_connections']).toEqual([
      { fileId: 'atem', id: 'conn-1', label: 'atem', moduleId: 'bmd-atem' },
    ]);
    expect(fake.connections.size).toBe(1);
  });

  it('reuses an existing connection with connection_mapping and creates nothing', async () => {
    const harness = await start(WRITE);
    const page = await atemPage(harness.call);
    await harness.call('import_page', { config: page, target_page: 1, dry_run: false });
    const { body } = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
      connection_mapping: { atem: 'conn-1' },
    });
    expect(body).toMatchObject({ ok: true, created_connections: [] });
    expect(fake.connections.size).toBe(1);
    const noMapping = await harness.call('import_page', {
      config: page,
      target_page: 1,
      dry_run: false,
    });
    expect(noMapping.body['created_connections']).toHaveLength(1);
    expect(fake.connections.size).toBe(2);
  });

  it('rolls back a page that uses a connection without creating a duplicate connection', async () => {
    const harness = await start(WRITE);
    const first = await atemPage(harness.call, 'FIRST');
    await harness.call('import_page', { config: first, target_page: 1, dry_run: false });
    const second = await atemPage(harness.call, 'SECOND');
    const changed = await harness.call('import_page', {
      config: second,
      target_page: 1,
      dry_run: false,
      connection_mapping: { atem: 'conn-1' },
    });
    expect(changed.body.ok).toBe(true);
    const snapshot = changed.body['snapshot'] as Snapshot;
    expect(Object.keys(snapshot.exportFile['instances'] as object)).toEqual(['conn-1']);

    const { body } = await harness.call('rollback', { snapshot, dry_run: false });
    expect(body).toMatchObject({ ok: true, readback: { ok: true }, created_connections: [] });
    expect(fake.pages[0]?.name).toBe('FIRST');
    expect(fake.connections.size).toBe(1);
  });
});

describe('secrets', () => {
  it('never puts the REST token into any tool result, including error paths', async () => {
    const token = 'cpn_super_secret_token_123';
    const harness = await start({ ...WRITE, COMPANION_REST_TOKEN: token });
    const page = await atemPage(harness.call);
    const outputs: unknown[] = [];
    const record = async (name: string, args: Record<string, unknown> = {}): Promise<void> => {
      outputs.push((await harness.call(name, args)).body);
    };
    await record('status');
    await record('list_connections');
    await record('list_surfaces');
    await record('get_page', { page: 1 });
    await record('get_page', { page: 99 });
    await record('export', { scope: { page: 99 } });
    await record('import_page', { config: page, target_page: 1 });
    await record('import_page', { config: page, target_page: 1, dry_run: false });
    fake.failNext('importExport.prepareImport.start', 'remote failure');
    await record('import_page', { config: page, target_page: 1, dry_run: false });
    const text = JSON.stringify(outputs);
    expect(text).not.toContain(token);
    expect(text).not.toContain('cpn_');
  });
});
