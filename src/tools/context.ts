import type { AppConfig } from '../config.js';
import { assertHostAllowed } from '../safety/index.js';
import { CompanionTrpc, RestV2Client } from '../transport/index.js';

/** Runs queued tasks one after another (Companion allows one upload session at a time). */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    // The queue continues whether the task fails or not; the caller still sees the error through `result`.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

export interface ToolContext {
  readonly config: AppConfig;
  /** Serializes applied imports and rollbacks. */
  readonly writeQueue: Mutex;
  /** Serializes Satellite tool calls: they share one fixed DEVICEID, which Companion allows once at a time. */
  readonly satelliteQueue: Mutex;
}

export function createContext(config: AppConfig): ToolContext {
  return { config, writeQueue: new Mutex(), satelliteQueue: new Mutex() };
}

/**
 * One Companion client per tool call: host check, connect (with version guard), run, close.
 * All import steps of a tool call share this connection (measured requirement of Companion).
 */
export async function withCompanion<T>(
  ctx: ToolContext,
  fn: (client: CompanionTrpc) => Promise<T>,
  options: { allowUnknownVersion?: boolean } = {},
): Promise<T> {
  assertHostAllowed(ctx.config.safety, ctx.config.url);
  const client = new CompanionTrpc();
  await client.connect(ctx.config.url, {
    allowUnknownVersion: options.allowUnknownVersion ?? ctx.config.allowUnknownVersion,
  });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/** REST v2 client for the configured Companion (host check included). */
export function restClient(ctx: ToolContext): RestV2Client {
  assertHostAllowed(ctx.config.safety, ctx.config.url);
  return new RestV2Client(ctx.config.url, ctx.config.restToken);
}
