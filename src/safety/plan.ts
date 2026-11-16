import { hostFromUrlOrHost, type SafetyConfig } from './config.js';
import type { SafetyErrorCode } from './errors.js';
import type { JsonObject } from './json.js';

export type PlannedOperation =
  | { kind: 'snapshot'; scope: 'full' | 'page'; page?: number; description: string }
  | {
      kind: 'import-page';
      targetPage: number;
      /** `-1` appends a new page at the end. */
      description: string;
      payloadBytes?: number;
    }
  | { kind: 'import-full'; description: string; payloadBytes?: number }
  | { kind: 'press'; page: number; row: number; column: number; description: string }
  | { kind: 'readback'; description: string };

/** Result of a dry run: what would happen, and what currently blocks it. Building a plan has no side effects. */
export interface WritePlan {
  readonly dryRun: true;
  readonly host: string;
  readonly operations: readonly PlannedOperation[];
  /** Safety gates that would refuse the real run right now (empty = would be allowed). */
  readonly blockedBy: readonly SafetyErrorCode[];
  readonly wouldBeAllowed: boolean;
  readonly warnings: readonly string[];
}

/** Builds a dry-run result. Pure: does not touch the network, the file system or the environment. */
export function planWrite(
  config: SafetyConfig,
  hostOrUrl: string,
  operations: readonly PlannedOperation[],
  warnings: readonly string[] = [],
): WritePlan {
  const host = hostFromUrlOrHost(hostOrUrl);
  const blockedBy: SafetyErrorCode[] = [];
  if (!config.writeEnabled) blockedBy.push('WRITE_DISABLED');
  if (!config.allowedHosts.includes(host)) blockedBy.push('HOST_NOT_ALLOWED');
  return {
    dryRun: true,
    host,
    operations: [...operations],
    blockedBy,
    wouldBeAllowed: blockedBy.length === 0,
    warnings: [...warnings],
  };
}

/** Convenience: the standard plan for replacing or appending a page: snapshot, import, read back. */
export function planPageImport(
  config: SafetyConfig,
  hostOrUrl: string,
  exportFile: JsonObject,
  targetPage: number,
): WritePlan {
  const payloadBytes = Buffer.byteLength(JSON.stringify(exportFile));
  const append = targetPage === -1;
  const operations: PlannedOperation[] = [];
  if (!append) {
    operations.push({
      kind: 'snapshot',
      scope: 'page',
      page: targetPage,
      description: `Export page ${targetPage} as rollback snapshot`,
    });
  }
  operations.push({
    kind: 'import-page',
    targetPage,
    payloadBytes,
    description: append
      ? 'Append the imported page at the end'
      : `Replace page ${targetPage} with the imported page`,
  });
  operations.push({
    kind: 'readback',
    description: 'Read the page back and diff against the intended content',
  });
  const warnings = append
    ? [
        'Appending creates a new page; there is no snapshot, rollback means deleting that page manually.',
      ]
    : [];
  return planWrite(config, hostOrUrl, operations, warnings);
}
