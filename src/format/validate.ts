/**
 * Offline validator for Companion export files (format version 12).
 *
 * It layers three kinds of checks:
 * 1. Project rules and measured pitfalls (docs/architecture.md, "Measured facts"): wrong version, legacy `button`
 *    controls, connections without `updatePolicy`, entities that Companion would drop silently, ...
 * 2. Structure, via the Zod schemas in `schema.ts` (reported as `missing-required-field`, `invalid-type`,
 *    `schema-invalid`; an issue that is already covered by a specific rule is not reported a second time).
 * 3. Optionally, module knowledge through a `CatalogLookup` (unknown modules, actions, feedbacks and options).
 *
 * Nothing here performs I/O. Paths are JSON Pointers into the validated document.
 */
import { z } from 'zod';
import {
  ActionEntitySchema,
  BoxLayerSchema,
  ButtonLayerSchema,
  CanvasLayerSchema,
  CircleLayerSchema,
  ExportFileSchema,
  FILE_VERSION,
  DEFAULT_GRID_SIZE,
  FeedbackEntitySchema,
  GaugeLayerSchema,
  GroupLayerSchema,
  ImageLayerSchema,
  LayeredButtonSchema,
  LineLayerSchema,
  ReferenceLayerSchema,
  TextLayerSchema,
} from './schema.js';

export interface Issue {
  /** JSON Pointer into the validated document, for example `/page/controls/0/1/steps/0`. */
  path: string;
  /** Stable machine readable code, for example `legacy-button-dropped-silently`. */
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/**
 * What the validator needs to know about Companion modules. `src/catalog` provides the data; this interface keeps
 * `src/format` free of a compile-time dependency on it (an adapter is a few lines).
 *
 * `options` handed to the `validate*Options` methods are the entity's options exactly as stored in the file, that
 * is wrapped as `{ isExpression, value }`. Issue paths returned by them are relative to that options object
 * (for example `/input`) and get prefixed with the entity's path by the validator.
 */
export interface CatalogLookup {
  hasModule(moduleId: string): boolean;
  findAction(moduleId: string, actionId: string): unknown;
  findFeedback(moduleId: string, feedbackId: string): unknown;
  validateActionOptions(
    moduleId: string,
    actionId: string,
    options: Record<string, unknown>,
  ): Issue[];
  /** Optional; feedback options are not checked when missing. */
  validateFeedbackOptions?(
    moduleId: string,
    feedbackId: string,
    options: Record<string, unknown>,
  ): Issue[];
}

export interface ValidateOptions {
  catalog?: CatalogLookup;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointer(base: string, ...segments: Array<string | number>): string {
  return (
    base + segments.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('')
  );
}

const INTEGER_KEY = /^-?\d+$/;
const INTERNAL_CONNECTIONS = new Set(['internal', 'bitfocus-companion']);
const CONTROL_TYPES = new Set([
  'button-layered',
  'preset-reference',
  'button-reference',
  'pagenum',
  'pageup',
  'pagedown',
]);
const FIXED_ACTION_SETS = new Set(['down', 'up', 'rotate_left', 'rotate_right']);
const UPDATE_POLICIES = new Set(['manual', 'stable', 'beta']);

const LAYER_SCHEMAS: Record<string, z.ZodObject | undefined> = {
  canvas: CanvasLayerSchema,
  box: BoxLayerSchema,
  text: TextLayerSchema,
  image: ImageLayerSchema,
  line: LineLayerSchema,
  circle: CircleLayerSchema,
  group: GroupLayerSchema,
  reference: ReferenceLayerSchema,
  gauge: GaugeLayerSchema,
};

/** True for `{ isExpression: boolean, value }` where expressions carry a string. */
function isValidOptionWrapper(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.isExpression !== 'boolean') return false;
  if (value.isExpression) return typeof value.value === 'string';
  return true;
}

function looksWrapped(value: unknown): boolean {
  return isRecord(value) && typeof value.isExpression === 'boolean';
}

class Collector {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];
  private readonly specificErrorPaths: string[] = [];

  error(path: string, code: string, message: string): void {
    this.errors.push({ path, code, message });
    this.specificErrorPaths.push(path);
  }

  warn(path: string, code: string, message: string): void {
    this.warnings.push({ path, code, message });
  }

  /** Schema issues are dropped when a specific error already covers the same location. */
  isCovered(path: string): boolean {
    return this.specificErrorPaths.some((p) => path === p || path.startsWith(p + '/'));
  }

  schemaError(path: string, code: string, message: string): void {
    if (this.isCovered(path)) return;
    this.errors.push({ path, code, message });
  }
}

function valueAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (typeof key === 'symbol' || typeof current !== 'object' || current === null)
      return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function mapZodIssue(
  issue: z.core.$ZodIssue,
  root: unknown,
  basePath: ReadonlyArray<PropertyKey>,
): { code: string; message: string } {
  const missing =
    (issue.code === 'invalid_type' && /received undefined/.test(issue.message)) ||
    // Wrapped values (`{ isExpression, value }`) are unions; a missing property shows up as an invalid union.
    (issue.code === 'invalid_union' && valueAt(root, [...basePath, ...issue.path]) === undefined);
  if (missing) {
    return { code: 'missing-required-field', message: issue.message };
  }
  if (issue.code === 'invalid_type') return { code: 'invalid-type', message: issue.message };
  return { code: 'schema-invalid', message: issue.message };
}

function reportZodIssues(
  issues: readonly z.core.$ZodIssue[],
  basePath: string,
  out: Collector,
  root: unknown,
  rootPath: ReadonlyArray<PropertyKey> = [],
): void {
  for (const issue of issues) {
    const path = pointer(
      basePath,
      ...issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
    );
    const { code, message } = mapZodIssue(issue, root, rootPath);
    out.schemaError(path, code, message);
  }
}

function warnUnknownKeys(
  value: UnknownRecord,
  schema: z.ZodObject | undefined,
  path: string,
  out: Collector,
  what: string,
): void {
  if (!schema) return;
  const known = new Set(Object.keys(schema.shape));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      out.warn(
        pointer(path, key),
        'unknown-key',
        `Unknown key "${key}" on ${what}; Companion ignores it. Check for a typo.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------------------------

interface Context {
  out: Collector;
  /** Connection IDs that the import will map (internal ones and `instances` entries with a label). */
  knownConnections: Set<string>;
  instances: Record<string, UnknownRecord>;
  catalog: CatalogLookup | undefined;
  entityIds: Map<string, string>;
}

interface EntityListContext {
  /** Expected `type` of the entities in this list, for the mismatch warning. */
  expectedType: 'action' | 'feedback';
  /** Layer IDs of the owning button; `undefined` where style overrides make no sense (triggers). */
  elementIds: Set<string> | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------------------------------

function checkInstances(instances: unknown, base: string, ctx: Context): void {
  if (instances === undefined || !isRecord(instances)) return;
  const labels = new Map<string, string>();
  for (const [id, raw] of Object.entries(instances)) {
    const path = pointer(base, id);
    if (INTERNAL_CONNECTIONS.has(id)) continue;
    if (!isRecord(raw)) {
      ctx.out.error(path, 'invalid-connection', 'A connection must be an object.');
      continue;
    }
    ctx.instances[id] = raw;

    if (typeof raw.label !== 'string' || raw.label === '') {
      ctx.out.error(
        pointer(path, 'label'),
        'connection-missing-label',
        'A connection without a label is skipped on import, and every entity that references it is dropped without a message.',
      );
    } else {
      ctx.knownConnections.add(id);
      const previous = labels.get(raw.label);
      if (previous !== undefined) {
        ctx.out.warn(
          pointer(path, 'label'),
          'duplicate-connection-label',
          `Connection label "${raw.label}" is also used by "${previous}"; variable references are label based.`,
        );
      } else {
        labels.set(raw.label, id);
      }
    }

    if (typeof raw.moduleId !== 'string' || raw.moduleId === '') {
      ctx.out.error(
        pointer(path, 'moduleId'),
        'missing-required-field',
        'A connection needs a moduleId.',
      );
    } else if (ctx.catalog && !ctx.catalog.hasModule(raw.moduleId)) {
      ctx.out.error(
        pointer(path, 'moduleId'),
        'unknown-module',
        `Module "${raw.moduleId}" is not in the catalog.`,
      );
    }

    if (raw.updatePolicy === undefined) {
      ctx.out.error(
        pointer(path, 'updatePolicy'),
        'connection-missing-update-policy',
        'A connection without updatePolicy makes REST v2 GET /connections/v1 fail with HTTP 500 (measured on 5.1.3). Use "manual".',
      );
    } else if (typeof raw.updatePolicy !== 'string' || !UPDATE_POLICIES.has(raw.updatePolicy)) {
      ctx.out.error(
        pointer(path, 'updatePolicy'),
        'connection-invalid-update-policy',
        'updatePolicy must be "manual", "stable" or "beta".',
      );
    }

    if (raw.lastUpgradeIndex === undefined) {
      ctx.out.warn(
        pointer(path, 'lastUpgradeIndex'),
        'connection-missing-last-upgrade-index',
        'Companion fills in -1 (all module upgrade scripts run on first start; a double migration is unmeasured). Set it explicitly.',
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------------------------

function walkEntity(
  entity: unknown,
  path: string,
  list: EntityListContext,
  ctx: Context,
  nested: boolean,
): void {
  if (!isRecord(entity)) return;
  const { out } = ctx;

  if (!nested && typeof entity.type === 'string' && entity.type !== list.expectedType) {
    if (entity.type === 'action' || entity.type === 'feedback') {
      out.warn(
        pathOf(path, 'type'),
        'entity-type-mismatch',
        `Expected a ${list.expectedType} entity in this list but found a ${entity.type}.`,
      );
    }
  }

  warnUnknownKeys(
    entity,
    entity.type === 'feedback' ? FeedbackEntitySchema : ActionEntitySchema,
    path,
    out,
    'an entity',
  );

  if (typeof entity.id === 'string') {
    const previous = ctx.entityIds.get(entity.id);
    if (previous !== undefined) {
      out.warn(
        pathOf(path, 'id'),
        'duplicate-entity-id',
        `Entity id "${entity.id}" is already used at ${previous}.`,
      );
    } else {
      ctx.entityIds.set(entity.id, path);
    }
  }

  // Option wrappers
  if (isRecord(entity.options)) {
    for (const [key, value] of Object.entries(entity.options)) {
      if (value === undefined) continue;
      if (!isValidOptionWrapper(value)) {
        out.error(
          pointer(path, 'options', key),
          'invalid-option-wrapper',
          `Option "${key}" must be { "isExpression": boolean, "value": ... } (expressions carry a string); raw values are not valid since Companion 4.3.`,
        );
      }
    }
  }
  if (entity.isInverted !== undefined && !isValidOptionWrapper(entity.isInverted)) {
    out.error(
      pointer(path, 'isInverted'),
      'invalid-option-wrapper',
      'isInverted must be { "isExpression": boolean, "value": ... }.',
    );
  }

  const connectionId = entity.connectionId;
  let moduleId: string | undefined;
  if (typeof connectionId === 'string' && !INTERNAL_CONNECTIONS.has(connectionId)) {
    if (!ctx.knownConnections.has(connectionId)) {
      out.error(
        pointer(path, 'connectionId'),
        'entity-unknown-connection',
        `Connection "${connectionId}" is not declared in "instances" (or has no label). Companion drops such entities on import without a message.`,
      );
    } else {
      const candidate = ctx.instances[connectionId]?.moduleId;
      if (typeof candidate === 'string') moduleId = candidate;
    }
  }

  // Catalog
  if (
    ctx.catalog &&
    moduleId !== undefined &&
    ctx.catalog.hasModule(moduleId) &&
    typeof entity.definitionId === 'string' &&
    isRecord(entity.options) &&
    (entity.type === 'action' || entity.type === 'feedback')
  ) {
    const isAction = entity.type === 'action';
    const found = isAction
      ? ctx.catalog.findAction(moduleId, entity.definitionId)
      : ctx.catalog.findFeedback(moduleId, entity.definitionId);
    if (found === undefined || found === null) {
      out.error(
        pointer(path, 'definitionId'),
        isAction ? 'unknown-action' : 'unknown-feedback',
        `Module "${moduleId}" has no ${entity.type} "${entity.definitionId}" in the catalog.`,
      );
    } else {
      const optionIssues = isAction
        ? ctx.catalog.validateActionOptions(moduleId, entity.definitionId, entity.options)
        : (ctx.catalog.validateFeedbackOptions?.(moduleId, entity.definitionId, entity.options) ??
          []);
      for (const issue of optionIssues) {
        const relative =
          issue.path === '' || issue.path.startsWith('/') ? issue.path : '/' + issue.path;
        out.error(pathOf(path, 'options') + relative, issue.code, issue.message);
      }
    }
  }

  // Style overrides must point at layers of the same button
  if (entity.type === 'feedback' && Array.isArray(entity.styleOverrides) && list.elementIds) {
    entity.styleOverrides.forEach((override: unknown, index: number) => {
      if (!isRecord(override) || typeof override.elementId !== 'string') return;
      if (!list.elementIds?.has(override.elementId)) {
        out.error(
          pointer(path, 'styleOverrides', index, 'elementId'),
          'override-unknown-element',
          `Style override targets layer "${override.elementId}" which does not exist on this button.`,
        );
      }
    });
  }

  // Children of internal entities
  if (isRecord(entity.children)) {
    for (const [group, children] of Object.entries(entity.children)) {
      if (!Array.isArray(children)) continue;
      children.forEach((child: unknown, index: number) =>
        walkEntity(child, pointer(path, 'children', group, index), list, ctx, true),
      );
    }
  }
}

function pathOf(base: string, key: string): string {
  return pointer(base, key);
}

function walkEntityList(
  entities: unknown,
  path: string,
  list: EntityListContext,
  ctx: Context,
): void {
  if (!Array.isArray(entities)) return;
  entities.forEach((entity: unknown, index: number) =>
    walkEntity(entity, pointer(path, index), list, ctx, false),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Layers and buttons
// ---------------------------------------------------------------------------------------------------------------

function collectLayerIds(
  layers: unknown[],
  path: string,
  ids: Set<string>,
  ctx: Context,
  isRoot: boolean,
): void {
  layers.forEach((layer, index) => {
    const layerPath = pointer(path, index);
    if (!isRecord(layer)) return;

    if (!isRoot) {
      // Root layers were already validated structurally by the parent schema; group children are checked here.
      const result = ButtonLayerSchema.safeParse(layer);
      if (!result.success) reportZodIssues(result.error.issues, layerPath, ctx.out, layer);
    }

    const type = typeof layer.type === 'string' ? layer.type : '';
    if (type !== 'composite') {
      warnUnknownKeys(
        layer,
        LAYER_SCHEMAS[type],
        layerPath,
        ctx.out,
        `a ${type || 'unknown'} layer`,
      );
    }

    if (type === 'canvas' && (!isRoot || index !== 0)) {
      ctx.out.error(
        layerPath,
        'canvas-not-first',
        'The canvas layer is the background element and may only be the first layer of the stack.',
      );
    }

    if (typeof layer.id === 'string') {
      if (ids.has(layer.id)) {
        ctx.out.error(
          pointer(layerPath, 'id'),
          'duplicate-element-id',
          `Layer id "${layer.id}" is used more than once on this button; style overrides could not tell the layers apart.`,
        );
      }
      ids.add(layer.id);
    }

    if (type === 'group' && Array.isArray(layer.children)) {
      collectLayerIds(layer.children, pointer(layerPath, 'children'), ids, ctx, false);
    }
  });
}

function walkButton(control: UnknownRecord, path: string, ctx: Context): void {
  warnUnknownKeys(control, LayeredButtonSchema, path, ctx.out, 'a button');

  const elementIds = new Set<string>();
  const style = control.style;
  if (isRecord(style) && Array.isArray(style.layers)) {
    collectLayerIds(style.layers, pointer(path, 'style', 'layers'), elementIds, ctx, true);
  }

  const rotary = isRecord(control.options) && control.options.rotaryActions === true;

  if (isRecord(control.steps)) {
    for (const [stepId, step] of Object.entries(control.steps)) {
      if (!isRecord(step) || !isRecord(step.action_sets)) continue;
      for (const [setId, actions] of Object.entries(step.action_sets)) {
        const setPath = pointer(path, 'steps', stepId, 'action_sets', setId);
        const numeric = setId.trim() !== '' && !Number.isNaN(Number(setId));
        if (!FIXED_ACTION_SETS.has(setId) && !numeric) {
          ctx.out.error(
            setPath,
            'invalid-action-set-id',
            `Action set "${setId}" is not down, up, rotate_left, rotate_right or a numeric hold duration; Companion skips it with a log warning.`,
          );
          continue;
        }
        if ((setId === 'rotate_left' || setId === 'rotate_right') && !rotary) {
          ctx.out.warn(
            setPath,
            'rotary-without-rotary-actions',
            'Rotate action sets are only used when options.rotaryActions is true.',
          );
        }
        walkEntityList(actions, setPath, { expectedType: 'action', elementIds }, ctx);
      }
    }
  }

  walkEntityList(
    control.feedbacks,
    pointer(path, 'feedbacks'),
    { expectedType: 'feedback', elementIds },
    ctx,
  );
  walkEntityList(
    control.localVariables,
    pointer(path, 'localVariables'),
    { expectedType: 'feedback', elementIds },
    ctx,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------

interface Grid {
  minColumn: number;
  maxColumn: number;
  minRow: number;
  maxRow: number;
}

function readGrid(value: unknown): Grid | undefined {
  if (!isRecord(value)) return undefined;
  const { minColumn, maxColumn, minRow, maxRow } = value;
  if (
    typeof minColumn !== 'number' ||
    typeof maxColumn !== 'number' ||
    typeof minRow !== 'number' ||
    typeof maxRow !== 'number'
  ) {
    return undefined;
  }
  return { minColumn, maxColumn, minRow, maxRow };
}

function walkPage(page: unknown, path: string, ctx: Context): void {
  if (!isRecord(page)) return;
  const { out } = ctx;

  const grid = readGrid(page.gridSize);
  if (grid) {
    if (grid.minColumn > grid.maxColumn || grid.minRow > grid.maxRow) {
      out.error(
        pointer(path, 'gridSize'),
        'invalid-grid',
        'gridSize minimums must not exceed the maximums.',
      );
    } else if (
      grid.minColumn < DEFAULT_GRID_SIZE.minColumn ||
      grid.maxColumn > DEFAULT_GRID_SIZE.maxColumn ||
      grid.minRow < DEFAULT_GRID_SIZE.minRow ||
      grid.maxRow > DEFAULT_GRID_SIZE.maxRow
    ) {
      out.warn(
        pointer(path, 'gridSize'),
        'grid-exceeds-default',
        'The page grid is larger than the default 8x4. Importing it enlarges the global grid size of the Companion installation.',
      );
    }
  }

  if (isRecord(page.controls)) {
    const seen = new Map<string, string>();
    for (const [rowKey, row] of Object.entries(page.controls)) {
      if (!isRecord(row)) continue;
      if (!INTEGER_KEY.test(rowKey)) {
        out.error(
          pointer(path, 'controls', rowKey),
          'invalid-coordinate',
          `Row key "${rowKey}" is not an integer.`,
        );
        continue;
      }
      for (const [columnKey, control] of Object.entries(row)) {
        const controlPath = pointer(path, 'controls', rowKey, columnKey);
        if (!INTEGER_KEY.test(columnKey)) {
          out.error(
            controlPath,
            'invalid-coordinate',
            `Column key "${columnKey}" is not an integer.`,
          );
          continue;
        }
        const rowNumber = Number(rowKey);
        const columnNumber = Number(columnKey);

        const position = `${rowNumber}/${columnNumber}`;
        const previous = seen.get(position);
        if (previous !== undefined) {
          out.error(
            controlPath,
            'duplicate-position',
            `Row ${rowNumber}, column ${columnNumber} is already used by ${previous}; one of the controls would be lost.`,
          );
        } else {
          seen.set(position, controlPath);
        }

        if (
          grid &&
          (rowNumber < grid.minRow ||
            rowNumber > grid.maxRow ||
            columnNumber < grid.minColumn ||
            columnNumber > grid.maxColumn)
        ) {
          out.error(
            controlPath,
            'coordinates-out-of-grid',
            `Row ${rowNumber}, column ${columnNumber} is outside the page grid (rows ${grid.minRow}..${grid.maxRow}, columns ${grid.minColumn}..${grid.maxColumn}).`,
          );
        }

        if (!isRecord(control)) continue;
        const type = control.type;
        if (type === 'button') {
          out.error(
            pointer(controlPath, 'type'),
            'legacy-button-dropped-silently',
            'Legacy control type "button" is not supported. Companion 5.1.3 converts it only for version 12 files and drops it silently (import reports success) for newer versions. Write "button-layered".',
          );
        } else if (typeof type !== 'string') {
          out.error(
            pointer(controlPath, 'type'),
            'missing-required-field',
            'A control needs a "type".',
          );
        } else if (!CONTROL_TYPES.has(type)) {
          out.error(
            pointer(controlPath, 'type'),
            'unknown-control-type',
            `Unknown control type "${type}"; Companion skips it on import with only a log warning.`,
          );
        } else if (type === 'button-layered' || type === 'preset-reference') {
          walkButton(control, controlPath, ctx);
        }
      }
    }
  }

  walkEntityList(
    page.pageVariables,
    pointer(path, 'pageVariables'),
    { expectedType: 'feedback', elementIds: undefined },
    ctx,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------------------------------------------

function collectCollectionIds(collections: unknown, ids: Set<string>): void {
  if (!Array.isArray(collections)) return;
  for (const collection of collections) {
    if (!isRecord(collection)) continue;
    if (typeof collection.id === 'string') ids.add(collection.id);
    collectCollectionIds(collection.children, ids);
  }
}

function walkTriggers(triggers: unknown, collections: unknown, path: string, ctx: Context): void {
  if (!isRecord(triggers)) return;
  const collectionIds = new Set<string>();
  collectCollectionIds(collections, collectionIds);

  for (const [id, trigger] of Object.entries(triggers)) {
    if (!isRecord(trigger)) continue;
    const triggerPath = pointer(path, id);

    if (isRecord(trigger.options)) {
      const collectionId = trigger.options.collectionId;
      if (typeof collectionId === 'string' && !collectionIds.has(collectionId)) {
        ctx.out.warn(
          pointer(triggerPath, 'options', 'collectionId'),
          'unknown-collection',
          `Trigger references collection "${collectionId}" that is not in triggerCollections.`,
        );
      }
    }

    if (Array.isArray(trigger.events)) {
      trigger.events.forEach((event: unknown, index: number) => {
        if (!isRecord(event) || !isRecord(event.options)) return;
        for (const [key, value] of Object.entries(event.options)) {
          if (looksWrapped(value)) {
            ctx.out.warn(
              pointer(triggerPath, 'events', index, 'options', key),
              'wrapped-event-option',
              'Event options are raw JSON values, not { isExpression, value } wrappers.',
            );
          }
        }
      });
    }

    walkEntityList(
      trigger.condition,
      pointer(triggerPath, 'condition'),
      { expectedType: 'feedback', elementIds: undefined },
      ctx,
    );
    walkEntityList(
      trigger.actions,
      pointer(triggerPath, 'actions'),
      { expectedType: 'action', elementIds: undefined },
      ctx,
    );
    walkEntityList(
      trigger.localVariables,
      pointer(triggerPath, 'localVariables'),
      { expectedType: 'feedback', elementIds: undefined },
      ctx,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

/**
 * Validate a parsed export (or its JSON text) against format version 12 and the measured pitfalls.
 * `ok` is `true` when there are no errors; warnings never fail validation.
 */
export function validateExport(json: unknown, options: ValidateOptions = {}): ValidationResult {
  const out = new Collector();
  const finish = (): ValidationResult => ({
    ok: out.errors.length === 0,
    errors: out.errors,
    warnings: out.warnings,
  });

  let data: unknown = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch (error) {
      out.error('', 'invalid-json', `Not valid JSON: ${(error as Error).message}`);
      return finish();
    }
  }
  if (!isRecord(data)) {
    out.error('', 'not-an-object', 'An export must be a JSON object.');
    return finish();
  }

  // Version
  if (data.version === undefined) {
    out.error(
      '/version',
      'missing-version',
      `The "version" field is required (must be ${FILE_VERSION}).`,
    );
  } else if (data.version !== FILE_VERSION) {
    out.error(
      '/version',
      'unsupported-version',
      `Export version must be ${FILE_VERSION} (written by Companion 5.0.0 to 5.1.3). Companion 5.1.3 performs no version check on import, but files with a newer version skip the migrations and drop legacy content silently.`,
    );
  }

  // Type
  const type = data.type;
  if (type !== 'page' && type !== 'trigger_list' && type !== 'full') {
    out.error(
      '/type',
      'unknown-export-type',
      'Export type must be "page", "trigger_list" or "full".',
    );
    return finish();
  }

  const ctx: Context = {
    out,
    knownConnections: new Set(),
    instances: {},
    catalog: options.catalog,
    entityIds: new Map(),
  };

  checkInstances(data.instances, '/instances', ctx);

  if (type === 'page') {
    walkPage(data.page, '/page', ctx);
  } else if (type === 'full') {
    if (isRecord(data.pages)) {
      for (const [number, page] of Object.entries(data.pages)) {
        if (!/^[1-9]\d*$/.test(number)) {
          out.error(
            pointer('/pages', number),
            'invalid-page-number',
            `Page key "${number}" is not a positive integer.`,
          );
        }
        walkPage(page, pointer('/pages', number), ctx);
      }
    }
    walkTriggers(data.triggers, data.triggerCollections, '/triggers', ctx);
  } else {
    walkTriggers(data.triggers, data.triggerCollections, '/triggers', ctx);
  }

  const parsed = ExportFileSchema.safeParse(data);
  if (!parsed.success) reportZodIssues(parsed.error.issues, '', out, data);

  return finish();
}
