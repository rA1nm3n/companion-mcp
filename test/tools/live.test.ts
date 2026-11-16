import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFor, startHarness, type Harness } from './helpers/harness.js';
import { startFakeCompanion, type FakeCompanion } from './helpers/fake-companion.js';

let fake: FakeCompanion;
let h: Harness | undefined;

beforeEach(async () => {
  fake = await startFakeCompanion({
    pages: [
      {
        name: 'Page One',
        controls: { '0': { '0': { type: 'pagenum' }, '1': { type: 'pageup' } } },
      },
    ],
  });
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  await fake.close();
});

describe('status', () => {
  it('reports version, REST state, safety configuration and no token', async () => {
    h = await startHarness(envFor(fake.url, { COMPANION_REST_TOKEN: 'cpn_secret_value' }));
    const { body } = await h.call('status');
    expect(body).toMatchObject({
      ok: true,
      ready: true,
      problems: [],
      target: { host: '127.0.0.1', hostAllowed: true },
      companion: {
        checked: true,
        reachable: true,
        version: '5.1.3',
        versionSupported: true,
        versionAllowed: true,
      },
      rest: { reachable: true, enabled: true, tokenConfigured: true },
      safety: {
        writeEnabled: false,
        allowedHosts: ['127.0.0.1', 'localhost', '::1'],
        pressAllowList: null,
      },
    });
    expect(JSON.stringify(body)).not.toContain('cpn_secret_value');
  });

  it('reports an unsupported version as not ready unless the override is set', async () => {
    await fake.close();
    fake = await startFakeCompanion({ version: '5.2.0' });
    h = await startHarness(envFor(fake.url));
    const refused = (await h.call('status')).body;
    expect(refused).toMatchObject({
      ready: false,
      companion: {
        reachable: true,
        version: '5.2.0',
        versionSupported: false,
        versionAllowed: false,
      },
    });
    await h.close();
    h = await startHarness(envFor(fake.url, { COMPANION_MCP_ALLOW_UNKNOWN_VERSION: '1' }));
    expect((await h.call('status')).body).toMatchObject({
      ready: true,
      companion: { versionSupported: false, versionAllowed: true },
      allowUnknownVersion: true,
    });
  });

  it('does not contact Companion when the host is not allowed', async () => {
    h = await startHarness(envFor(fake.url, { COMPANION_MCP_ALLOWED_HOSTS: 'other.example' }));
    const { body } = await h.call('status');
    expect(body).toMatchObject({
      ok: true,
      ready: false,
      target: { hostAllowed: false },
      companion: { checked: false },
    });
    expect(fake.server.calls).toEqual([]);
  });

  it('reports an unreachable Companion without throwing', async () => {
    await fake.close();
    h = await startHarness(envFor(fake.url));
    const { body } = await h.call('status');
    expect(body).toMatchObject({ ok: true, ready: false, companion: { reachable: false } });
    // Restart a fake so afterEach can close it again.
    fake = await startFakeCompanion();
  });
});

describe('export, get_page', () => {
  it('exports a single page and the full configuration', async () => {
    h = await startHarness(envFor(fake.url));
    const page = await h.call('export', { scope: { page: 1 } });
    expect(page.body).toMatchObject({
      ok: true,
      scope: { page: 1 },
      export: { type: 'page', version: 12 },
    });
    const full = await h.call('export', { scope: 'full' });
    expect(full.body).toMatchObject({ ok: true, scope: 'full', export: { type: 'full' } });
  });

  it('fails clearly for a page that does not exist (HTTP 404)', async () => {
    h = await startHarness(envFor(fake.url));
    const { body, isError } = await h.call('export', { scope: { page: 5 } });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'HTTP_ERROR', source: 'transport' });
    expect(body).not.toHaveProperty('stack');
  });

  it('reads a page back with name and controls', async () => {
    h = await startHarness(envFor(fake.url));
    const { body } = await h.call('get_page', { page: 1 });
    expect(body).toMatchObject({
      ok: true,
      page: 1,
      name: 'Page One',
      controlCount: 2,
      controls: { '0': { '0': { type: 'pagenum' }, '1': { type: 'pageup' } } },
    });
  });

  it('fails for a missing page and for an invalid page number', async () => {
    h = await startHarness(envFor(fake.url));
    expect((await h.call('get_page', { page: 9 })).body).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
    });
    const invalid = await h.client.callTool({ name: 'companion_get_page', arguments: { page: 0 } });
    expect(invalid.isError).toBe(true);
  });

  it('uses one connection per tool call and closes it', async () => {
    h = await startHarness(envFor(fake.url));
    await h.call('get_page', { page: 1 });
    await h.call('get_page', { page: 1 });
    const connections = new Set(fake.server.calls.map((c) => c.connection));
    expect([...connections]).toEqual([0, 1]);
  });
});

describe('host allow-list and version guard on live read tools', () => {
  it('refuses a host that is not on the allow-list before connecting', async () => {
    h = await startHarness(envFor(fake.url, { COMPANION_MCP_ALLOWED_HOSTS: 'other.example' }));
    for (const [name, args] of [
      ['get_page', { page: 1 }],
      ['export', { scope: 'full' }],
      ['list_connections', {}],
      ['list_surfaces', {}],
    ] as const) {
      const { body, isError } = await h.call(name, args);
      expect(isError).toBe(true);
      expect(body).toMatchObject({ ok: false, code: 'HOST_NOT_ALLOWED', source: 'safety' });
    }
    expect(fake.server.calls).toEqual([]);
  });

  it('refuses an unsupported Companion version', async () => {
    await fake.close();
    fake = await startFakeCompanion({ version: '5.2.0' });
    h = await startHarness(envFor(fake.url));
    expect((await h.call('get_page', { page: 1 })).body).toMatchObject({
      ok: false,
      code: 'VERSION_UNSUPPORTED',
    });
    await h.close();
    h = await startHarness(envFor(fake.url, { COMPANION_MCP_ALLOW_UNKNOWN_VERSION: 'true' }));
    expect((await h.call('get_page', { page: 1 })).body.ok).toBe(true);
  });
});

describe('list_connections, list_surfaces', () => {
  it('needs a token and says so', async () => {
    h = await startHarness(envFor(fake.url));
    const { body, isError } = await h.call('list_connections');
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'REST_TOKEN_MISSING' });
    expect(String(body['message'])).toContain('COMPANION_REST_TOKEN');
  });

  it('lists connections and surfaces and redacts secret-looking fields', async () => {
    h = await startHarness(envFor(fake.url, { COMPANION_REST_TOKEN: 'cpn_secret_value' }));
    const connections = await h.call('list_connections');
    expect(connections.body).toMatchObject({ ok: true, count: 1 });
    expect(JSON.stringify(connections.body)).not.toContain('leak-me');
    expect(JSON.stringify(connections.body)).not.toContain('cpn_secret_value');
    const surfaces = await h.call('list_surfaces');
    expect(surfaces.body).toMatchObject({ ok: true, count: 1, surfaces: [{ id: 's1' }] });
  });
});
