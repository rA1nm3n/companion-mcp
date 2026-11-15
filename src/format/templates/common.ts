/**
 * Shared helpers for the page templates. Templates are pure functions that return export objects; they never
 * perform I/O and take an injectable ID generator for reproducible output.
 */
import { buildConnection, type ConnectionInput, type IdGenerator } from '../builders.js';
import type { ExportInstance, UpdatePolicy } from '../schema.js';

/** The connection a template page refers to. `id` is the key used in `instances` and by the entities. */
export interface TemplateConnection {
  /** Connection ID inside the file; Companion maps it to an existing connection on import. */
  id: string;
  /** Connection label (also used in `$(label:variable)` references). */
  label: string;
  /** Default `'manual'`. */
  updatePolicy?: UpdatePolicy;
  /** Default `-1`. */
  lastUpgradeIndex?: number;
  moduleVersionId?: string | null;
}

export interface TemplateBaseOptions {
  connection: TemplateConnection;
  /** Page name; every template has its own default. */
  pageName?: string;
  /** Add the standard page navigation buttons and shift the layout one column to the right. Default `false`. */
  navigation?: boolean;
  /** Page number recorded in `oldPageNumber`. Default 1. */
  oldPageNumber?: number;
  companionBuild?: string;
  notes?: string;
  /** Inject for reproducible IDs, e.g. `createSequentialIdGenerator()`. */
  ids?: IdGenerator;
}

export function instancesFor(
  moduleId: string,
  connection: TemplateConnection,
): Record<string, ExportInstance> {
  const input: ConnectionInput = { moduleId, label: connection.label };
  if (connection.updatePolicy !== undefined) input.updatePolicy = connection.updatePolicy;
  if (connection.lastUpgradeIndex !== undefined)
    input.lastUpgradeIndex = connection.lastUpgradeIndex;
  if (connection.moduleVersionId !== undefined) input.moduleVersionId = connection.moduleVersionId;
  return { [connection.id]: buildConnection(input) };
}

/** Column where the template layout starts (column 0 is taken by the navigation buttons when enabled). */
export function startColumn(options: TemplateBaseOptions): number {
  return options.navigation === true ? 1 : 0;
}

export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${String(value)}`);
  }
}

/** Number of columns available in a row (the default grid has 8). */
export function availableColumns(
  options: TemplateBaseOptions,
  columns: number | undefined,
): number {
  const requested = columns ?? 8 - startColumn(options);
  assertPositiveInteger(requested, 'columns');
  return requested;
}

export interface LabeledInput<T extends number | string = number> {
  input: T;
  label?: string;
}

/** Accept `[1, 2, {input: 3, label: 'X'}]` or a count (`4` means inputs 1..4). */
export function normalizeInputs<T extends number | string>(
  inputs: number | Array<T | LabeledInput<T>>,
  name: string,
): Array<LabeledInput<T>> {
  if (typeof inputs === 'number') {
    assertPositiveInteger(inputs, name);
    return Array.from({ length: inputs }, (_, i) => ({ input: (i + 1) as T }));
  }
  if (inputs.length === 0) throw new Error(`${name} must not be empty`);
  return inputs.map((entry) =>
    typeof entry === 'object' && entry !== null ? entry : { input: entry },
  );
}
