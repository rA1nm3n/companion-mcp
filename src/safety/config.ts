import { SafetyError } from './errors.js';

export interface PressLocation {
  page: number;
  row: number;
  column: number;
}

export interface SafetyConfig {
  /** `COMPANION_MCP_WRITE=1` (or `true`). Default: false. */
  readonly writeEnabled: boolean;
  /** Normalized (lower case, no IPv6 brackets) host names. Default: 127.0.0.1, localhost, ::1. */
  readonly allowedHosts: readonly string[];
  /** `null` means no restriction on which buttons may be pressed. */
  readonly pressAllow: readonly PressLocation[] | null;
}

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

/** Lower-cases and strips the brackets of IPv6 literals (`[::1]` becomes `::1`). */
export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * Extracts the normalized host from a URL (`http://127.0.0.1:8000/x`, `ws://[::1]:8000`) or a bare host.
 * Ports are ignored on purpose: the allow-list is per host.
 */
export function hostFromUrlOrHost(input: string): string {
  const value = input.trim();
  if (value === '') throw new SafetyError('CONFIG_INVALID', 'Empty host');
  if (value.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new SafetyError('CONFIG_INVALID', `Invalid URL: ${value}`);
    }
    return normalizeHost(parsed.hostname);
  }
  // Bare host, optionally with port. IPv6 literals without brackets contain several colons.
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return normalizeHost(end === -1 ? value : value.slice(0, end + 1));
  }
  const colons = value.split(':').length - 1;
  if (colons === 1) return normalizeHost(value.slice(0, value.indexOf(':')));
  return normalizeHost(value);
}

function parseWriteFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function parseHosts(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ALLOWED_HOSTS;
  const hosts = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map(normalizeHost);
  if (hosts.length === 0) return DEFAULT_ALLOWED_HOSTS;
  return [...new Set(hosts)];
}

/** Parses `page/row/column` (comma separated). Fails closed: any malformed entry throws. */
function parsePressAllow(raw: string | undefined): readonly PressLocation[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const result: PressLocation[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(trimmed);
    if (!match) {
      throw new SafetyError(
        'CONFIG_INVALID',
        `COMPANION_MCP_PRESS_ALLOW entry "${trimmed}" is not of the form page/row/column`,
      );
    }
    const page = Number(match[1]);
    if (page < 1) {
      throw new SafetyError(
        'CONFIG_INVALID',
        `COMPANION_MCP_PRESS_ALLOW entry "${trimmed}": page numbers start at 1`,
      );
    }
    result.push({ page, row: Number(match[2]), column: Number(match[3]) });
  }
  return result;
}

/** Reads the safety configuration from an environment object. Defaults: writes off, loopback only. */
export function loadSafetyConfig(env: Readonly<Record<string, string | undefined>>): SafetyConfig {
  return {
    writeEnabled: parseWriteFlag(env['COMPANION_MCP_WRITE']),
    allowedHosts: parseHosts(env['COMPANION_MCP_ALLOWED_HOSTS']),
    pressAllow: parsePressAllow(env['COMPANION_MCP_PRESS_ALLOW']),
  };
}
