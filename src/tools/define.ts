import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { failureFrom } from './result.js';

export const TOOL_PREFIX = 'companion_';

export interface ToolDefinition<S extends z.ZodObject> {
  /** Name without the `companion_` prefix. */
  name: string;
  title: string;
  /** Must state side effects. */
  description: string;
  /** Strict object schema (`z.strictObject`). */
  input: S;
  annotations: ToolAnnotations;
  run: (args: z.output<S>) => Promise<CallToolResult>;
}

/** Registers one tool. Exceptions of the handler become `ok: false` results, never protocol errors. */
export function defineTool<S extends z.ZodObject>(server: McpServer, def: ToolDefinition<S>): void {
  server.registerTool(
    `${TOOL_PREFIX}${def.name}`,
    {
      title: def.title,
      description: def.description,
      // The SDK types the callback from the schema; the generic is erased here and restored in the cast below.
      inputSchema: def.input as z.ZodObject,
      annotations: def.annotations,
    },
    async (args): Promise<CallToolResult> => {
      try {
        return await def.run(args as z.output<S>);
      } catch (error) {
        return failureFrom(error);
      }
    },
  );
}

/** Annotations for tools without side effects. `openWorld` is true when the tool talks to Companion. */
export function readOnly(title: string, openWorld: boolean): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: openWorld,
  };
}
