import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConfigError } from '../config.js';
import { SafetyError } from '../safety/index.js';
import { TransportError } from '../transport/index.js';

export type ErrorSource = 'safety' | 'transport' | 'config' | 'input' | 'validation' | 'internal';

/** Machine readable error of a tool result (`ok: false`). Never contains a stack trace or a token. */
export interface ToolFailure {
  code: string;
  message: string;
  source: ErrorSource;
  /** Extra fields of the remote error (HTTP status, tRPC path), only for transport errors. */
  details?: Record<string, unknown>;
}

function render(body: Record<string, unknown>, isError: boolean): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  };
  if (isError) result.isError = true;
  return result;
}

/** Success result: structured JSON text `{ ok: true, ... }`. */
export function success(data: Record<string, unknown> = {}): CallToolResult {
  return render({ ok: true, ...data }, false);
}

/** Failure result: `{ ok: false, code, message, source, ... }` with `isError: true`. `extra` can carry context such as a snapshot. */
export function failure(error: ToolFailure, extra: Record<string, unknown> = {}): CallToolResult {
  const { details, ...rest } = error;
  return render(
    { ok: false, ...rest, ...(details === undefined ? {} : { details }), ...extra },
    true,
  );
}

/** Maps the typed errors of the project to a {@link ToolFailure}. Everything else becomes `INTERNAL_ERROR` (message only). */
export function describeError(error: unknown): ToolFailure {
  if (error instanceof SafetyError) {
    return { code: error.code, message: error.message, source: 'safety' };
  }
  if (error instanceof TransportError) {
    const details: Record<string, unknown> = {};
    if (error.path !== undefined) details['path'] = error.path;
    if (error.remoteCode !== undefined) details['remoteCode'] = error.remoteCode;
    if (error.status !== undefined) details['status'] = error.status;
    return {
      code: error.code,
      message: error.message,
      source: 'transport',
      ...(Object.keys(details).length === 0 ? {} : { details }),
    };
  }
  if (error instanceof ConfigError) {
    return { code: 'CONFIG_INVALID', message: error.message, source: 'config' };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unknown error',
    source: 'internal',
  };
}

/** Failure result for any thrown value. */
export function failureFrom(error: unknown, extra: Record<string, unknown> = {}): CallToolResult {
  return failure(describeError(error), extra);
}

const SECRET_KEY = /token|password|passwd|secret|api[-_]?key/i;

/** Defensive copy that replaces values of secret-looking keys; used for data that comes from Companion. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactSecrets(entry);
    }
    return out;
  }
  return value;
}
