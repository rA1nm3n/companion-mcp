import { isJsonObject, type JsonObject, type JsonValue } from '../safety/json.js';

export type DeviationKind =
  /** Intended control is absent after the import (Companion silently dropped it; measured pitfall). */
  | 'control-dropped'
  | 'control-type-mismatch'
  | 'value-mismatch'
  | 'missing-property'
  | 'extra-property'
  | 'extra-control'
  | 'page-name-mismatch';

export interface Deviation {
  kind: DeviationKind;
  /** `error` makes the read-back fail; `warning` is informational. */
  severity: 'error' | 'warning';
  /** Dotted path, e.g. `controls.0.1.steps.0.action_sets.down.0.options.value`. */
  path: string;
  message: string;
  intended?: JsonValue;
  actual?: JsonValue;
}

export interface ReadbackSummary {
  controlsIntended: number;
  controlsMatched: number;
  controlsDropped: number;
}

export interface ReadbackResult {
  ok: boolean;
  deviations: Deviation[];
  summary: ReadbackSummary;
}

export interface DiffOptions {
  /** Report properties present only in the actual data as warnings. Default true. */
  reportExtraProperties?: boolean;
}

/** Control types Companion adds to every page itself; extra ones in the actual data are not a deviation. */
const NAVIGATION_TYPES = new Set(['pageup', 'pagenum', 'pagedown']);

type ControlMap = Map<string, JsonObject>;

/** Accepts an export file (`page.controls`), a page object (`controls`) or a bare `{row:{col:control}}` map. */
function extractControls(input: JsonObject): { controls: JsonObject; name: string | undefined } {
  const page = input['page'];
  if (isJsonObject(page) && isJsonObject(page['controls'])) {
    return {
      controls: page['controls'],
      name: typeof page['name'] === 'string' ? page['name'] : undefined,
    };
  }
  if (isJsonObject(input['controls'])) {
    return {
      controls: input['controls'],
      name: typeof input['name'] === 'string' ? input['name'] : undefined,
    };
  }
  return { controls: input, name: undefined };
}

function flatten(controls: JsonObject): ControlMap {
  const map: ControlMap = new Map();
  for (const [row, columns] of Object.entries(controls)) {
    if (!isJsonObject(columns)) continue;
    for (const [column, control] of Object.entries(columns)) {
      if (isJsonObject(control)) map.set(`${row}/${column}`, control);
    }
  }
  return map;
}

function isEntity(value: JsonObject): boolean {
  return (value['type'] === 'action' || value['type'] === 'feedback') && 'connectionId' in value;
}

function compare(
  intended: JsonValue,
  actual: JsonValue,
  path: string,
  out: Deviation[],
  options: Required<DiffOptions>,
  insideEntity: boolean,
): void {
  if (isJsonObject(intended) && isJsonObject(actual)) {
    const entity = isEntity(intended) || isEntity(actual);
    for (const key of Object.keys(intended)) {
      // Measured: Companion assigns new entity IDs on import; upgradeIndex is overwritten from the instance.
      if (entity && (key === 'id' || key === 'upgradeIndex')) continue;
      const here = `${path}.${key}`;
      const want = intended[key];
      const got = actual[key];
      if (want === undefined) continue;
      if (got === undefined) {
        out.push({
          kind: 'missing-property',
          severity: 'error',
          path: here,
          message: `Property ${here} was not stored`,
          intended: want,
        });
        continue;
      }
      compare(want, got, here, out, options, entity || insideEntity);
    }
    for (const key of Object.keys(actual)) {
      if (key in intended) continue;
      if (entity && (key === 'id' || key === 'upgradeIndex')) continue;
      // Measured: the v16 to v17 import upgrade adds pinnedProperties to layers when the file lacks them.
      if (key === 'pinnedProperties') continue;
      if (!options.reportExtraProperties) continue;
      const here = `${path}.${key}`;
      out.push({
        kind: 'extra-property',
        severity: 'warning',
        path: here,
        message: `Companion added property ${here}`,
        actual: actual[key] as JsonValue,
      });
    }
    return;
  }
  if (Array.isArray(intended) && Array.isArray(actual)) {
    if (intended.length !== actual.length) {
      out.push({
        kind: 'value-mismatch',
        severity: 'error',
        path,
        message: `Array length differs at ${path}: intended ${intended.length}, actual ${actual.length}`,
        intended,
        actual,
      });
    }
    const length = Math.min(intended.length, actual.length);
    for (let i = 0; i < length; i++) {
      compare(
        intended[i] as JsonValue,
        actual[i] as JsonValue,
        `${path}.${i}`,
        out,
        options,
        insideEntity,
      );
    }
    return;
  }
  if (!Object.is(intended, actual) && !(intended === 0 && actual === 0)) {
    out.push({
      kind: 'value-mismatch',
      severity: 'error',
      path,
      message: `Value differs at ${path}`,
      intended,
      actual,
    });
  }
}

/**
 * Compares the content intended for an import with what Companion reports afterwards. Tolerates the
 * differences measured on Companion 5.1.3: newly assigned entity IDs, `upgradeIndex` inheritance and
 * `pinnedProperties` added by the import upgrade. Everything else is a deviation. A control that is missing
 * after the import is reported as `control-dropped` (Companion drops unknown control types silently).
 */
export function diffReadback(
  intended: JsonObject,
  actual: JsonObject,
  options: DiffOptions = {},
): ReadbackResult {
  const opts: Required<DiffOptions> = {
    reportExtraProperties: options.reportExtraProperties ?? true,
  };
  const want = extractControls(intended);
  const got = extractControls(actual);
  const wantMap = flatten(want.controls);
  const gotMap = flatten(got.controls);
  const deviations: Deviation[] = [];
  let matched = 0;
  let dropped = 0;

  if (want.name !== undefined && got.name !== undefined && want.name !== got.name) {
    deviations.push({
      kind: 'page-name-mismatch',
      severity: 'error',
      path: 'name',
      message: `Page name differs: intended "${want.name}", actual "${got.name}"`,
      intended: want.name,
      actual: got.name,
    });
  }

  for (const [key, control] of wantMap) {
    const [row, column] = key.split('/');
    const path = `controls.${row}.${column}`;
    const found = gotMap.get(key);
    if (!found) {
      dropped++;
      deviations.push({
        kind: 'control-dropped',
        severity: 'error',
        path,
        message: `Control ${key} (type ${String(control['type'])}) is missing after the import (silently dropped)`,
        intended: control,
      });
      continue;
    }
    if (control['type'] !== found['type']) {
      deviations.push({
        kind: 'control-type-mismatch',
        severity: 'error',
        path: `${path}.type`,
        message: `Control ${key} has type ${String(found['type'])}, intended ${String(control['type'])}`,
        intended: control['type'] as JsonValue,
        actual: found['type'] as JsonValue,
      });
      continue;
    }
    const before = deviations.length;
    compare(control, found, path, deviations, opts, false);
    if (!deviations.slice(before).some((d) => d.severity === 'error')) matched++;
  }

  for (const [key, control] of gotMap) {
    if (wantMap.has(key)) continue;
    if (typeof control['type'] === 'string' && NAVIGATION_TYPES.has(control['type'])) continue;
    const [row, column] = key.split('/');
    deviations.push({
      kind: 'extra-control',
      severity: 'warning',
      path: `controls.${row}.${column}`,
      message: `Control ${key} exists after the import but was not intended`,
      actual: control,
    });
  }

  return {
    ok: !deviations.some((d) => d.severity === 'error'),
    deviations,
    summary: { controlsIntended: wantMap.size, controlsMatched: matched, controlsDropped: dropped },
  };
}
