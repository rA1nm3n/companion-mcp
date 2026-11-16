import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type AppConfig } from '../../../src/config.js';
import { createServer } from '../../../src/server.js';

export type ToolBody = { ok: boolean; [key: string]: unknown };

export interface Harness {
  client: Client;
  config: AppConfig;
  /** Calls a tool (name without prefix) and parses the JSON text result. */
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ body: ToolBody; isError: boolean }>;
  close: () => Promise<void>;
}

export function envFor(url: string, extra: Record<string, string> = {}): Record<string, string> {
  return { COMPANION_URL: url, ...extra };
}

/** Starts the real server in-process and connects an SDK client through linked in-memory transports. */
export async function startHarness(env: Record<string, string>): Promise<Harness> {
  const config = loadConfig(env);
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    config,
    call: async (name, args = {}) => {
      const result = await client.callTool({ name: `companion_${name}`, arguments: args });
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content[0]?.text ?? '';
      return { body: JSON.parse(text) as ToolBody, isError: result.isError === true };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
