import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type AppConfig } from './config.js';
import { registerTools } from './tools/index.js';

export const SERVER_NAME = 'companion-mcp';

/** Package version, read from `package.json` next to `src/` or `dist/`. */
function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const INSTRUCTIONS = [
  'Tools for creating and maintaining Bitfocus Companion configuration (pages, buttons, actions, feedbacks).',
  'Recommended flow: companion_catalog_* to find modules and action ids, companion_generate_page or companion_build_page, companion_validate_config, companion_import_page with dry_run=true, then dry_run=false, then companion_get_page to verify, companion_rollback if needed.',
  'Writes are disabled unless the server runs with COMPANION_MCP_WRITE=1, and only allow-listed hosts are contacted. Never guess option ids: look them up in the catalog.',
].join(' ');

/** Creates the MCP server with all tools. The configuration is explicit so that tests can inject their own. */
export function createServer(config: AppConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: packageVersion() },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, config);
  return server;
}

export interface StdioIo {
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Loads the configuration from `env`, creates the server and serves it on stdio. `stdout` belongs to the
 * protocol: nothing else may write to it. Throws `ConfigError`/`SafetyError` for an invalid environment.
 */
export async function startStdioServer(
  env: Readonly<Record<string, string | undefined>>,
  io: StdioIo = {},
): Promise<{ server: McpServer; config: AppConfig }> {
  const config = loadConfig(env);
  const server = createServer(config);
  await server.connect(new StdioServerTransport(io.stdin, io.stdout));
  return { server, config };
}
