import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../src/safety/json.js';
import { CompanionTrpc, TransportError } from '../../src/transport/index.js';
import { buildTestPage } from './fixtures.js';
import {
  DROP_CONNECTION,
  installDefaultHandlers,
  MockRemoteError,
  NO_RESPONSE,
  startMockServer,
  type MockServer,
} from './mock-server.js';

const IMPORT_PATHS = [
  'importExport.prepareImport.start',
  'importExport.prepareImport.uploadChunk',
  'importExport.prepareImport.complete',
  'importExport.importSinglePage',
];

function installImportHandlers(server: MockServer): void {
  server.setHandler('importExport.prepareImport.start', () => 'session-1');
  server.setHandler('importExport.prepareImport.uploadChunk', () => 1);
  server.setHandler('importExport.prepareImport.complete', () => [null, { type: 'page' }]);
  server.setHandler('importExport.importSinglePage', () => ({ internal: 'internal' }));
}

describe('CompanionTrpc', () => {
  let server: MockServer;
  let client: CompanionTrpc;

  beforeEach(async () => {
    server = await startMockServer();
    installDefaultHandlers(server);
    client = new CompanionTrpc();
  });

  afterEach(async () => {
    client.close();
    await server.close();
  });

  describe('connect and version guard', () => {
    it('connects and reads the version via appInfo.version', async () => {
      await client.connect(server.url);
      expect(client.connected).toBe(true);
      expect(await client.getVersion()).toEqual({ appVersion: '5.1.3', appBuild: '5.1.3+test' });
      expect(server.calls[0]).toMatchObject({
        method: 'query',
        path: 'appInfo.version',
        input: { all: true },
      });
    });

    it('accepts any 5.1.x patch version', async () => {
      installDefaultHandlers(server, '5.1.9');
      await client.connect(server.url);
      expect(client.version?.appVersion).toBe('5.1.9');
    });

    it.each(['5.2.0', '4.0.1', '6.0.0', 'garbage'])(
      'refuses version %s by default',
      async (version) => {
        installDefaultHandlers(server, version);
        await expect(client.connect(server.url)).rejects.toMatchObject({
          code: 'VERSION_UNSUPPORTED',
        });
        expect(client.connected).toBe(false);
      },
    );

    it('accepts an unknown version with allowUnknownVersion', async () => {
      installDefaultHandlers(server, '5.2.0');
      await client.connect(server.url, { allowUnknownVersion: true });
      expect(client.connected).toBe(true);
    });

    it('fails with CONNECT_FAILED when nothing listens', async () => {
      await server.close();
      await expect(
        new CompanionTrpc().connect(server.url, { timeoutMs: 1000 }),
      ).rejects.toMatchObject({
        code: 'CONNECT_FAILED',
      });
      server = await startMockServer();
    });

    it('rejects an invalid URL', async () => {
      await expect(client.connect('not a url')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it('refuses to connect twice on the same instance', async () => {
      await client.connect(server.url);
      await expect(client.connect(server.url)).rejects.toMatchObject({
        code: 'RECONNECT_FORBIDDEN',
      });
    });
  });

  describe('wire protocol', () => {
    beforeEach(async () => {
      await client.connect(server.url);
    });

    it('parses remote errors with remote code and path', async () => {
      server.setHandler('boom', () => {
        throw new MockRemoteError('kaputt', 'BAD_REQUEST');
      });
      await expect(client.mutation('boom', {})).rejects.toMatchObject({
        code: 'REMOTE_ERROR',
        remoteCode: 'BAD_REQUEST',
        path: 'boom',
      });
    });

    it('reports an unknown procedure as REMOTE_ERROR NOT_FOUND', async () => {
      await expect(client.query('does.not.exist')).rejects.toMatchObject({
        code: 'REMOTE_ERROR',
        remoteCode: 'NOT_FOUND',
      });
    });

    it('times out when the server never answers', async () => {
      server.setHandler('slow', () => NO_RESPONSE);
      await expect(client.query('slow', undefined, 150)).rejects.toMatchObject({ code: 'TIMEOUT' });
    });

    it('matches responses to requests by id when answers arrive out of order', async () => {
      server.setHandler('a', async () => {
        await new Promise((r) => setTimeout(r, 80));
        return 'A';
      });
      server.setHandler('b', () => 'B');
      const [a, b] = await Promise.all([client.query('a'), client.query('b')]);
      expect([a, b]).toEqual(['A', 'B']);
    });

    it('reads the first item of a subscription and stops it', async () => {
      server.setHandler('pages.watch', () => ({ type: 'init', order: [] }));
      expect(await client.firstOfSubscription('pages.watch')).toEqual({ type: 'init', order: [] });
    });

    it('answers a server PING with PONG and stays usable', async () => {
      server.sendRaw('PING');
      expect(await client.getVersion()).toMatchObject({ appVersion: '5.1.3' });
      expect(server.pongs.count).toBe(1);
    });

    it('fails pending calls with CLOSED when the server drops the connection and never reconnects', async () => {
      server.setHandler('drop', () => DROP_CONNECTION);
      await expect(client.query('drop')).rejects.toMatchObject({ code: 'CLOSED' });
      await expect(client.query('appInfo.version')).rejects.toBeInstanceOf(TransportError);
      expect(client.connected).toBe(false);
      expect(new Set(server.calls.map((c) => c.connection)).size).toBe(1);
    });

    it('rejects calls after close()', async () => {
      client.close();
      await expect(client.query('appInfo.version')).rejects.toMatchObject({ code: 'CLOSED' });
    });
  });

  describe('importPage', () => {
    beforeEach(async () => {
      await client.connect(server.url);
      installImportHandlers(server);
      server.calls.length = 0;
    });

    it('runs start, uploadChunk, complete and importSinglePage in order on the same connection', async () => {
      const exportFile = buildTestPage();
      const result = await client.importPage({ exportFile, targetPage: 1 });

      const importCalls = server.calls.filter((c) => IMPORT_PATHS.includes(c.path));
      expect(importCalls.map((c) => c.path)).toEqual(IMPORT_PATHS);
      expect(importCalls.every((c) => c.method === 'mutation')).toBe(true);
      expect(new Set(importCalls.map((c) => c.connection)).size).toBe(1);
      expect(result.remapping).toEqual({ internal: 'internal' });
    });

    it('uploads the exact bytes with matching size and SHA-1 checksum', async () => {
      const exportFile = buildTestPage();
      const bytes = Buffer.from(JSON.stringify(exportFile), 'utf8');
      await client.importPage({ exportFile, targetPage: 2 });

      const start = server.calls.find((c) => c.path === 'importExport.prepareImport.start');
      const chunk = server.calls.find((c) => c.path === 'importExport.prepareImport.uploadChunk');
      const complete = server.calls.find((c) => c.path === 'importExport.prepareImport.complete');
      expect(start?.input).toMatchObject({ size: bytes.length });
      const chunkInput = chunk?.input as { sessionId: string; offset: number; data: string };
      expect(chunkInput.sessionId).toBe('session-1');
      expect(chunkInput.offset).toBe(0);
      expect(Buffer.from(chunkInput.data, 'base64').equals(bytes)).toBe(true);
      expect(complete?.input).toEqual({
        sessionId: 'session-1',
        expectedChecksum: createHash('sha1').update(bytes).digest('hex'),
        userData: null,
      });
    });

    it('splits large files into several chunks with increasing offsets', async () => {
      const exportFile = buildTestPage({ text: 'x'.repeat(600 * 1024) });
      await client.importPage({ exportFile, targetPage: 1 });
      const chunks = server.calls.filter(
        (c) => c.path === 'importExport.prepareImport.uploadChunk',
      );
      expect(chunks.length).toBeGreaterThan(2);
      const offsets = chunks.map((c) => (c.input as { offset: number }).offset);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
      expect(offsets[0]).toBe(0);
    });

    it('passes targetPage -1 (append), sourcePage and the connection mapping to importSinglePage', async () => {
      await client.importPage({
        exportFile: buildTestPage(),
        targetPage: -1,
        connectionMapping: { old: 'new' },
      });
      const call = server.calls.find((c) => c.path === 'importExport.importSinglePage');
      expect(call?.input).toEqual({
        targetPage: -1,
        sourcePage: 1,
        connectionIdRemapping: { old: 'new' },
      });
    });

    it.each([0, -2, 1.5, Number.NaN])(
      'rejects invalid targetPage %s without any call',
      async (targetPage) => {
        await expect(
          client.importPage({ exportFile: buildTestPage(), targetPage }),
        ).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
        });
        expect(server.calls).toHaveLength(0);
      },
    );

    it('turns a prepare error into IMPORT_FAILED, cancels the session and skips importSinglePage', async () => {
      server.setHandler('importExport.prepareImport.complete', () => ['Invalid file', null]);
      server.setHandler('importExport.prepareImport.cancel', () => null);
      server.setHandler('importExport.abort', () => null);
      await expect(
        client.importPage({ exportFile: buildTestPage(), targetPage: 1 }),
      ).rejects.toMatchObject({
        code: 'IMPORT_FAILED',
      });
      const paths = server.calls.map((c) => c.path);
      expect(paths).not.toContain('importExport.importSinglePage');
      expect(paths).toContain('importExport.abort');
    });

    it('propagates remote errors of importSinglePage and clears the pending import', async () => {
      server.setHandler('importExport.importSinglePage', () => {
        throw new MockRemoteError('Invalid target page');
      });
      server.setHandler('importExport.abort', () => null);
      await expect(
        client.importPage({ exportFile: buildTestPage(), targetPage: 9 }),
      ).rejects.toMatchObject({
        code: 'REMOTE_ERROR',
        path: 'importExport.importSinglePage',
      });
      expect(server.calls.map((c) => c.path)).toContain('importExport.abort');
    });

    it('cancels the upload session when an upload step fails', async () => {
      server.setHandler('importExport.prepareImport.uploadChunk', () => {
        throw new MockRemoteError('Invalid session or offset');
      });
      server.setHandler('importExport.prepareImport.cancel', () => null);
      await expect(
        client.importPage({ exportFile: buildTestPage(), targetPage: 1 }),
      ).rejects.toMatchObject({
        code: 'REMOTE_ERROR',
      });
      const cancel = server.calls.find((c) => c.path === 'importExport.prepareImport.cancel');
      expect(cancel?.input).toEqual({ sessionId: 'session-1' });
    });

    it('times out a stuck step', async () => {
      const slowClient = new CompanionTrpc();
      await slowClient.connect(server.url, { importTimeoutMs: 150 });
      server.setHandler('importExport.prepareImport.complete', () => NO_RESPONSE);
      server.setHandler('importExport.prepareImport.cancel', () => null);
      await expect(
        slowClient.importPage({ exportFile: buildTestPage(), targetPage: 1 }),
      ).rejects.toMatchObject({
        code: 'TIMEOUT',
      });
      slowClient.close();
    });

    it('never reconnects when the connection drops mid-import and reports IMPORT_CONNECTION_LOST', async () => {
      server.setHandler('importExport.prepareImport.complete', () => DROP_CONNECTION);
      const before = new Set(server.calls.map((c) => c.connection));
      await expect(
        client.importPage({ exportFile: buildTestPage(), targetPage: 1 }),
      ).rejects.toMatchObject({
        code: 'IMPORT_CONNECTION_LOST',
      });
      expect(client.connected).toBe(false);
      expect(server.calls.map((c) => c.path)).not.toContain('importExport.importSinglePage');
      const after = new Set(server.calls.map((c) => c.connection));
      expect(after.size).toBe(Math.max(before.size, 1));
    });

    it('refuses connect() while an import is running and a second concurrent import', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.setHandler('importExport.prepareImport.start', async () => {
        await gate;
        return 'session-1';
      });
      const first = client.importPage({ exportFile: buildTestPage(), targetPage: 1 });
      await expect(client.connect(server.url)).rejects.toMatchObject({
        code: 'RECONNECT_FORBIDDEN',
      });
      await expect(
        client.importPage({ exportFile: buildTestPage(), targetPage: 1 }),
      ).rejects.toMatchObject({
        code: 'IMPORT_IN_PROGRESS',
      });
      release();
      await first;
    });
  });

  describe('getPage', () => {
    it('reads layout with pages.watch and each control with controls.watchControl', async () => {
      await client.connect(server.url);
      server.setHandler('pages.watch', () => ({
        type: 'init',
        order: ['p1', 'p2'],
        pages: {
          p1: { id: 'p1', name: 'ONE', controls: {} },
          p2: { id: 'p2', name: 'TWO', controls: { '0': { '0': 'ctl-a', '2': 'ctl-b' } } },
        },
      }));
      server.setHandler('controls.watchControl', (input) => {
        const { controlId } = input as { controlId: string };
        return { type: 'init', config: { type: 'button-layered', marker: controlId }, runtime: {} };
      });
      const page = await client.getPage(2);
      expect(page.name).toBe('TWO');
      expect(page.list.map((c) => [c.row, c.column, c.controlId])).toEqual([
        [0, 0, 'ctl-a'],
        [0, 2, 'ctl-b'],
      ]);
      expect((page.controls['0'] as JsonObject)['2']).toMatchObject({ marker: 'ctl-b' });
    });

    it('rejects a page number beyond the page count', async () => {
      await client.connect(server.url);
      server.setHandler('pages.watch', () => ({
        type: 'init',
        order: ['p1'],
        pages: { p1: { name: 'A' } },
      }));
      await expect(client.getPage(3)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });
  });

  describe('exports over HTTP', () => {
    it('fetches full and page exports', async () => {
      const page = buildTestPage();
      const httpServer = await startMockServer({
        '/int/export/full?format=json': { version: 12, type: 'full' },
        '/int/export/page/3?format=json': page,
      });
      installDefaultHandlers(httpServer);
      const c = new CompanionTrpc();
      await c.connect(httpServer.url);
      expect(await c.exportFull()).toMatchObject({ type: 'full' });
      expect(await c.exportPage(3)).toEqual(page);
      await expect(c.exportPage(4)).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 404 });
      await expect(c.exportPage(0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      c.close();
      await httpServer.close();
    });
  });
});
