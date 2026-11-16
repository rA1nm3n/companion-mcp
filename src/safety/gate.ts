import { hostFromUrlOrHost, type SafetyConfig } from './config.js';
import { SafetyError } from './errors.js';

/** Throws `HOST_NOT_ALLOWED` unless the host (or URL) is on the allow-list. Ports are ignored. */
export function assertHostAllowed(config: SafetyConfig, hostOrUrl: string): void {
  const host = hostFromUrlOrHost(hostOrUrl);
  if (!config.allowedHosts.includes(host)) {
    throw new SafetyError(
      'HOST_NOT_ALLOWED',
      `Host "${host}" is not in COMPANION_MCP_ALLOWED_HOSTS (allowed: ${config.allowedHosts.join(', ')})`,
    );
  }
}

/** Every write needs the write flag and an allowed host. Throws `WRITE_DISABLED` or `HOST_NOT_ALLOWED`. */
export function assertWriteAllowed(config: SafetyConfig, hostOrUrl: string): void {
  if (!config.writeEnabled) {
    throw new SafetyError(
      'WRITE_DISABLED',
      'Writing is disabled. Set COMPANION_MCP_WRITE=1 to enable it.',
    );
  }
  assertHostAllowed(config, hostOrUrl);
}

/**
 * Pressing a button acts on live equipment, so it needs the write gate as well (stricter than the bare
 * allow-list). If `COMPANION_MCP_PRESS_ALLOW` is set, the button must be listed. Throws `PRESS_NOT_ALLOWED`.
 */
export function assertPressAllowed(
  config: SafetyConfig,
  hostOrUrl: string,
  location: { page: number; row: number; column: number },
): void {
  assertWriteAllowed(config, hostOrUrl);
  if (config.pressAllow === null) return;
  const listed = config.pressAllow.some(
    (entry) =>
      entry.page === location.page &&
      entry.row === location.row &&
      entry.column === location.column,
  );
  if (!listed) {
    throw new SafetyError(
      'PRESS_NOT_ALLOWED',
      `Pressing ${location.page}/${location.row}/${location.column} is not in COMPANION_MCP_PRESS_ALLOW`,
    );
  }
}
