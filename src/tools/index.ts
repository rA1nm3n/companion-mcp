import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from '../config.js';
import { createContext } from './context.js';
import { registerLiveTools } from './live.js';
import { registerOfflineTools } from './offline.js';
import { registerSatelliteTools } from './satellite.js';
import { registerWriteTools } from './write.js';

export { TOOL_PREFIX } from './define.js';
export { Mutex, createContext, type ToolContext } from './context.js';

/** Registers all tools (offline, live read, live write, Satellite snapshot and press). */
export function registerTools(server: McpServer, config: AppConfig): void {
  const ctx = createContext(config);
  registerOfflineTools(server);
  registerLiveTools(server, ctx);
  registerWriteTools(server, ctx);
  registerSatelliteTools(server, ctx);
}
