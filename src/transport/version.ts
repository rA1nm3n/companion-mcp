import { TransportError } from './errors.js';

/** Companion minor line this client was verified against (5.1.3). */
export const SUPPORTED_VERSION_LINE = '5.1';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Version guard: only Companion 5.1.x is accepted. Other major/minor lines (and unparsable versions) are
 * refused unless `allowUnknownVersion` is set, because the tRPC API is internal and undocumented.
 */
export function assertSupportedVersion(version: string, allowUnknownVersion: boolean): void {
  const parsed = parseVersion(version);
  const supported = parsed !== null && `${parsed.major}.${parsed.minor}` === SUPPORTED_VERSION_LINE;
  if (supported || allowUnknownVersion) return;
  throw new TransportError(
    'VERSION_UNSUPPORTED',
    `Companion version "${version}" is not ${SUPPORTED_VERSION_LINE}.x. The internal tRPC API is untested there; ` +
      'set allowUnknownVersion to proceed at your own risk.',
  );
}
