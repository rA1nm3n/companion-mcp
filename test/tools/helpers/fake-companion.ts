import type { JsonObject } from '../../../src/safety/json.js';
import {
  installDefaultHandlers,
  MockRemoteError,
  startMockServer,
  type MockServer,
} from '../../transport/mock-server.js';

/**
 * Stateful fake of the parts of Companion that the tools use, built on the shared mock WebSocket server:
 * pages hold controls, `importSinglePage` stores the uploaded page (assigning new entity ids like Companion does),
 * `pages.watch`/`controls.watchControl` read them back and `/int/export/page/<n>` exports them.
 */
export interface FakeCompanion {
  server: MockServer;
  url: string;
  pages: FakePage[];
  /** Control types that the fake drops silently on import (the measured legacy-button trap). */
  dropTypes: Set<string>;
  /** Delay inside `uploadChunk`, to make overlapping imports observable. */
  uploadDelayMs: { value: number };
  /** Connections that exist in the fake (id to info). */
  connections: Map<string, JsonObject>;
  /** Highest number of upload sessions that were open at the same time. */
  maxOpenSessions: () => number;
  /** Replaces the handler of a procedure so the next call fails. */
  failNext: (path: string, message: string) => void;
  close: () => Promise<void>;
}

export interface FakePage {
  name: string;
  /** `{ row: { column: control config } }` */
  controls: Record<string, Record<string, JsonObject>>;
}

/**
 * Mimics what was measured on 5.1.3: entities get new ids, `connectionId` is remapped, and entities of module
 * connections do not keep an empty `children` object.
 */
function entityIds(
  value: unknown,
  counter: { n: number },
  remapping: Record<string, string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) entityIds(entry, counter, remapping);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  if ((record['type'] === 'action' || record['type'] === 'feedback') && 'connectionId' in record) {
    record['id'] = `new-${counter.n++}`;
    const from = String(record['connectionId']);
    record['connectionId'] = remapping[from] ?? from;
    if (from !== 'internal') delete record['children'];
  }
  for (const child of Object.values(record)) entityIds(child, counter, remapping);
}

export async function startFakeCompanion(
  options: { version?: string; pages?: FakePage[] } = {},
): Promise<FakeCompanion> {
  const pages: FakePage[] = options.pages ?? [
    { name: 'Original', controls: { '0': { '0': { type: 'pagenum' } } } },
  ];
  const dropTypes = new Set<string>();
  const uploadDelayMs = { value: 0 };
  const sessions = new Map<string, string[]>();
  let open = 0;
  let maxOpen = 0;
  let uploaded: JsonObject | undefined;
  let controlSeq = 0;
  const controlIds = new Map<string, JsonObject>();
  const counter = { n: 1 };
  const connections = new Map<string, JsonObject>();
  let connectionSeq = 0;

  const exportOf = (index: number): JsonObject => {
    const page = pages[index];
    if (!page) throw new Error('no such page');
    return {
      version: 12,
      type: 'page',
      page: {
        name: page.name,
        controls: page.controls,
        gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 },
      },
      instances: Object.fromEntries(
        [...connections].filter(([id]) => JSON.stringify(page.controls).includes(id)),
      ),
      connectionCollections: [],
      oldPageNumber: index + 1,
      imageLibrary: [],
      imageLibraryCollections: [],
    } as unknown as JsonObject;
  };

  const routes: Record<string, unknown> = {};
  for (let n = 1; n <= 9; n++) {
    Object.defineProperty(routes, `/int/export/page/${n}?format=json`, {
      enumerable: true,
      get: () => (pages[n - 1] ? exportOf(n - 1) : undefined),
    });
  }

  routes['/int/export/full?format=json'] = { version: 12, type: 'full', pages: {} };
  routes['/api/v2/openapi.json'] = { openapi: '3.0.3' };
  routes['/api/v2/connections/v1'] = {
    data: [
      {
        id: 'c1',
        label: 'atem',
        moduleId: 'bmd-atem',
        config: { host: 'example.invalid', apiToken: 'leak-me' },
      },
    ],
  };
  routes['/api/v2/surfaces/v1'] = { data: [{ id: 's1', type: 'Streamdeck' }] };

  const server = await startMockServer(routes);
  installDefaultHandlers(server, options.version ?? '5.1.3');

  server.setHandler('importExport.prepareImport.start', () => {
    open++;
    maxOpen = Math.max(maxOpen, open);
    const id = `session-${sessions.size + 1}`;
    sessions.set(id, []);
    return id;
  });
  server.setHandler('importExport.prepareImport.uploadChunk', async (input) => {
    const { sessionId, data } = input as { sessionId: string; data: string };
    if (uploadDelayMs.value > 0) await new Promise((r) => setTimeout(r, uploadDelayMs.value));
    sessions.get(sessionId)?.push(data);
    return 1;
  });
  server.setHandler('importExport.prepareImport.complete', (input) => {
    const { sessionId } = input as { sessionId: string };
    const raw = Buffer.concat((sessions.get(sessionId) ?? []).map((c) => Buffer.from(c, 'base64')));
    uploaded = JSON.parse(raw.toString('utf8')) as JsonObject;
    return [null, { type: 'page' }];
  });
  server.setHandler('importExport.importSinglePage', (input) => {
    const { targetPage, connectionIdRemapping } = input as {
      targetPage: number;
      connectionIdRemapping: Record<string, string>;
    };
    const remapping: Record<string, string> = {
      internal: 'internal',
      'bitfocus-companion': 'internal',
    };
    const fileInstances = (uploaded?.['instances'] ?? {}) as Record<string, JsonObject>;
    for (const [fileId, instance] of Object.entries(fileInstances)) {
      const mapped = connectionIdRemapping[fileId];
      if (mapped !== undefined) {
        remapping[fileId] = mapped;
      } else {
        const id = `conn-${++connectionSeq}`;
        connections.set(id, {
          id,
          label: String(instance['label']),
          moduleId: instance['moduleId'] ?? '',
        });
        remapping[fileId] = id;
      }
    }
    const source = (uploaded?.['page'] ?? {}) as { name: string; controls: FakePage['controls'] };
    const controls: FakePage['controls'] = JSON.parse(JSON.stringify(source.controls));
    for (const [row, columns] of Object.entries(controls)) {
      for (const [column, control] of Object.entries(columns)) {
        if (dropTypes.has(String(control['type']))) delete columns[column];
        else entityIds(control, counter, remapping);
      }
      if (Object.keys(controls[row] ?? {}).length === 0) delete controls[row];
    }
    const page: FakePage = { name: source.name, controls };
    if (targetPage === -1) pages.push(page);
    else pages[targetPage - 1] = page;
    open--;
    return remapping;
  });
  server.setHandler('importExport.prepareImport.cancel', () => {
    open = Math.max(0, open - 1);
    return null;
  });
  server.setHandler('importExport.abort', () => null);

  server.setHandler('instances.connections.watch', () => [
    { type: 'init', info: Object.fromEntries(connections) },
  ]);
  server.setHandler('pages.watch', () => ({
    type: 'init',
    order: pages.map((_, i) => `page-${i + 1}`),
    pages: Object.fromEntries(
      pages.map((page, i) => {
        const layout: Record<string, Record<string, string>> = {};
        for (const [row, columns] of Object.entries(page.controls)) {
          for (const [column, control] of Object.entries(columns)) {
            const id = `control-${++controlSeq}`;
            controlIds.set(id, control);
            (layout[row] ??= {})[column] = id;
          }
        }
        return [`page-${i + 1}`, { name: page.name, controls: layout }];
      }),
    ),
  }));
  server.setHandler('controls.watchControl', (input) => {
    const { controlId } = input as { controlId: string };
    const config = controlIds.get(controlId);
    if (!config) throw new MockRemoteError('unknown control');
    return { config };
  });

  return {
    server,
    url: server.url,
    pages,
    dropTypes,
    uploadDelayMs,
    connections,
    maxOpenSessions: () => maxOpen,
    failNext: (path, message) => {
      const previous = server.handlers.get(path);
      server.setHandler(path, () => {
        if (previous) server.setHandler(path, previous);
        throw new MockRemoteError(message);
      });
    },
    close: () => server.close(),
  };
}
