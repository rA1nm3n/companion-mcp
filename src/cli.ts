#!/usr/bin/env node
import { hostFromUrlOrHost } from './safety/index.js';
import { SERVER_NAME, startStdioServer } from './server.js';

/** stdout is reserved for the MCP protocol; all diagnostics go to stderr and never contain tokens. */
function log(message: string): void {
  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
}

async function main(): Promise<void> {
  const { server, config } = await startStdioServer(process.env);
  log(
    `ready on stdio (target host ${hostFromUrlOrHost(config.url)}, writes ${config.safety.writeEnabled ? 'ENABLED' : 'disabled'})`,
  );
  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
