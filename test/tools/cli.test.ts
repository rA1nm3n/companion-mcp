import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config.js';
import { startStdioServer } from '../../src/server.js';

const EXPECTED_TOOL_COUNT = 15;

/** Newline-delimited JSON-RPC over two in-process streams: exactly what the stdio transport does on a real pipe. */
describe('stdio server (in-process streams)', () => {
  it('answers initialize and tools/list, and writes nothing but protocol messages to stdout', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: string[] = [];
    let buffer = '';
    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    const { server } = await startStdioServer({}, { stdin, stdout });
    const send = (message: unknown): void => void stdin.write(`${JSON.stringify(message)}\n`);
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(predicate()).toBe(true);
    };

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    });
    await waitFor(() => lines.length >= 1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await waitFor(() => lines.length >= 2);

    const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const message of messages) expect(message['jsonrpc']).toBe('2.0');
    const init = messages[0] as { result: { serverInfo: { name: string }; instructions: string } };
    expect(init.result.serverInfo.name).toBe('companion-mcp');
    expect(init.result.instructions).toContain('COMPANION_MCP_WRITE');
    const list = messages[1] as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(list.result.tools.every((tool) => tool.name.startsWith('companion_'))).toBe(true);
    await server.close();
  });

  it('fails with a ConfigError for an invalid environment instead of starting', async () => {
    await expect(
      startStdioServer(
        { COMPANION_URL: 'nonsense' },
        { stdin: new PassThrough(), stdout: new PassThrough() },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

// The compiled binary is only tested when `npm run build` was run (the test never builds).
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const source = fileURLToPath(new URL('../../src/server.ts', import.meta.url));
const built = existsSync(cli) && statSync(cli).mtimeMs >= statSync(source).mtimeMs;

describe.skipIf(!built)('dist/cli.js (spawned, only after npm run build)', () => {
  it('serves tools/list over a real stdio pipe', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'cli-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);
    } finally {
      await client.close();
    }
  });

  it('exits with code 1 and a message on stderr for an invalid configuration, stdout stays empty', () => {
    const result = spawnSync(process.execPath, [cli], {
      env: { ...process.env, COMPANION_URL: 'nonsense', COMPANION_REST_TOKEN: 'cpn_do_not_print' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('companion-mcp: fatal');
    expect(result.stderr).not.toContain('cpn_do_not_print');
  });
});
