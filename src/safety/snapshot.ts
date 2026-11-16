import { createHash } from 'node:crypto';
import { SafetyError } from './errors.js';
import { isJsonObject, type JsonObject } from './json.js';
import type { PlannedOperation } from './plan.js';

export type SnapshotScope = { kind: 'full' } | { kind: 'page'; page: number };

/** A snapshot is simply the export of the affected scope plus metadata for integrity and traceability. */
export interface Snapshot {
  readonly createdAt: string;
  readonly host: string;
  readonly scope: SnapshotScope;
  readonly companionVersion?: string;
  /** SHA-256 over the canonical JSON of `exportFile`. */
  readonly checksum: string;
  readonly exportFile: JsonObject;
}

export interface RollbackOperation {
  kind: 'import-page' | 'import-full';
  /** Present for `import-page`. */
  targetPage?: number;
  /** The unchanged snapshot export that gets re-imported. */
  exportFile: JsonObject;
}

export interface RollbackPlan {
  readonly dryRun: true;
  readonly operations: readonly RollbackOperation[];
  readonly description: readonly PlannedOperation[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function checksumOf(exportFile: JsonObject): string {
  return createHash('sha256').update(canonicalJson(exportFile)).digest('hex');
}

export interface CreateSnapshotInput {
  host: string;
  scope: SnapshotScope;
  exportFile: JsonObject;
  companionVersion?: string;
  now?: () => Date;
}

export function createSnapshot(input: CreateSnapshotInput): Snapshot {
  const expectedType = input.scope.kind === 'full' ? 'full' : 'page';
  if (input.exportFile['type'] !== expectedType) {
    throw new SafetyError(
      'SNAPSHOT_INVALID',
      `Snapshot scope "${input.scope.kind}" needs an export of type "${expectedType}", got "${String(input.exportFile['type'])}"`,
    );
  }
  const snapshot: Snapshot = {
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    host: input.host,
    scope: input.scope,
    checksum: checksumOf(input.exportFile),
    exportFile: input.exportFile,
    ...(input.companionVersion === undefined ? {} : { companionVersion: input.companionVersion }),
  };
  return snapshot;
}

/** True if the export still matches the checksum taken at snapshot time. */
export function verifySnapshot(snapshot: Snapshot): boolean {
  return checksumOf(snapshot.exportFile) === snapshot.checksum;
}

/**
 * Rollback = re-import of the unchanged snapshot export (page snapshot replaces the same page number).
 * Refuses a snapshot whose content changed since it was taken.
 */
export function planRollback(snapshot: Snapshot): RollbackPlan {
  if (!verifySnapshot(snapshot)) {
    throw new SafetyError('SNAPSHOT_INVALID', 'Snapshot checksum mismatch: content was modified');
  }
  if (snapshot.scope.kind === 'page') {
    const page = snapshot.scope.page;
    return {
      dryRun: true,
      operations: [{ kind: 'import-page', targetPage: page, exportFile: snapshot.exportFile }],
      description: [
        {
          kind: 'import-page',
          targetPage: page,
          description: `Re-import the snapshot taken at ${snapshot.createdAt} into page ${page}`,
        },
      ],
    };
  }
  return {
    dryRun: true,
    operations: [{ kind: 'import-full', exportFile: snapshot.exportFile }],
    description: [
      {
        kind: 'import-full',
        description: `Re-import the full snapshot taken at ${snapshot.createdAt}`,
      },
    ],
  };
}
