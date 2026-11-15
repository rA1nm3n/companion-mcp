/**
 * Pure builders for Companion export objects (format version 12, `button-layered` controls).
 *
 * The shapes mirror the files that were really imported into Companion 5.1.3 (see docs/architecture.md, measured
 * facts 1, 2 and 5): version 12, `button-layered` only, option values wrapped as `{ isExpression, value }`, every
 * connection with an explicit `updatePolicy`.
 *
 * Nothing here performs I/O. IDs come from an injectable generator so that output can be made deterministic.
 */
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_GRID_SIZE,
  FILE_VERSION,
  type ActionEntity,
  type BoxLayer,
  type Control,
  type ExportInstance,
  type FeedbackEntity,
  type GridSize,
  type LayeredButton,
  type OptionsObject,
  type PageExport,
  type StyleOverride,
  type TextLayer,
  type Trigger,
  type TriggerCollection,
  type TriggerEvent,
  type TriggerExport,
  type UpdatePolicy,
  ExpressionOrJsonValueSchema,
} from './schema.js';

// ---------------------------------------------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------------------------------------------

export type IdKind =
  | 'element'
  | 'action'
  | 'feedback'
  | 'override'
  | 'variable'
  | 'trigger'
  | 'event'
  | 'page'
  | 'collection';

/** Produces a new unique ID for the given kind of object. */
export type IdGenerator = (kind: IdKind) => string;

const ID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

/**
 * Default generator: 21 random characters from the URL-safe alphabet, the same shape as the `nanoid()` IDs that
 * Companion itself generates (Companion does not require a particular format, only uniqueness).
 */
export const randomIdGenerator: IdGenerator = () => {
  const bytes = randomBytes(21);
  let id = '';
  for (const byte of bytes) id += ID_ALPHABET[byte & 63];
  return id;
};

/** Deterministic generator for tests and reproducible output: `element-1`, `element-2`, `action-1`, ... */
export function createSequentialIdGenerator(prefix = ''): IdGenerator {
  const counters = new Map<IdKind, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${prefix}${kind}-${next}`;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Option wrappers
// ---------------------------------------------------------------------------------------------------------------

type JsonPrimitive = string | number | boolean | null;
export type JsonLike = JsonPrimitive | JsonLike[] | { [key: string]: JsonLike | undefined };

/** A plain JSON value (wrapped automatically) or an already wrapped `{ isExpression, value }`. */
export type OptionInput = JsonLike | { isExpression: boolean; value?: JsonLike | undefined };

/** Wrap a plain value: `{ isExpression: false, value }`. */
export function val<T extends JsonLike | undefined>(value: T): { isExpression: false; value: T } {
  return { isExpression: false, value };
}

/** Wrap an expression string: `{ isExpression: true, value }`. */
export function expr(expression: string): { isExpression: true; value: string } {
  return { isExpression: true, value: expression };
}

function isWrapped(input: unknown): input is { isExpression: boolean; value?: unknown } {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as { isExpression?: unknown }).isExpression === 'boolean'
  );
}

/** Wrap every option that is not already wrapped. Throws if a wrapped option is malformed. */
export function toOptions(options: Record<string, OptionInput> = {}): OptionsObject {
  const result: OptionsObject = {};
  for (const [key, input] of Object.entries(options)) {
    const wrapped = isWrapped(input) ? input : val(input);
    const parsed = ExpressionOrJsonValueSchema.safeParse(wrapped);
    if (!parsed.success) {
      throw new Error(`Option "${key}" is not a valid { isExpression, value } wrapper`);
    }
    result[key] = parsed.data;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------------------------------

export interface ConnectionInput {
  moduleId: string;
  label: string;
  /** Default `'manual'`: a missing `updatePolicy` breaks REST v2 `GET /connections/v1` (500, measured). */
  updatePolicy?: UpdatePolicy;
  /** Default `-1` (what Companion fills in for a missing value; all module upgrade scripts run on first start). */
  lastUpgradeIndex?: number;
  moduleVersionId?: string | null;
  sortOrder?: number;
  collectionId?: string;
}

/** Minimal connection entry as found in the `instances` of page and trigger exports. */
export function buildConnection(input: ConnectionInput): ExportInstance {
  const connection: ExportInstance = {
    label: input.label,
    moduleId: input.moduleId,
    lastUpgradeIndex: input.lastUpgradeIndex ?? -1,
    moduleVersionId: input.moduleVersionId ?? null,
    updatePolicy: input.updatePolicy ?? 'manual',
    sortOrder: input.sortOrder ?? 0,
  };
  if (input.collectionId !== undefined) connection.collectionId = input.collectionId;
  return connection;
}

// ---------------------------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------------------------

export interface ActionInput {
  /** `'internal'` or a key of the export's `instances`. */
  connectionId: string;
  definitionId: string;
  options?: Record<string, OptionInput>;
  headline?: string;
  disabled?: boolean;
}

export interface FeedbackStyleInput {
  /** Background color applied while the feedback is active (boolean feedbacks). */
  bgColor?: number | string;
  /** Text color applied while the feedback is active (boolean feedbacks). */
  textColor?: number | string;
  /**
   * For `advanced` feedbacks the module returns the style itself; name the property of its result to take the
   * color from (for example `'bgcolor'`). Mutually exclusive with `bgColor`/`textColor` semantics: the values are
   * property names, not colors.
   */
  bgFromResult?: string;
  textFromResult?: string;
}

export interface FeedbackInput {
  connectionId: string;
  definitionId: string;
  options?: Record<string, OptionInput>;
  isInverted?: boolean;
  headline?: string;
  style?: FeedbackStyleInput;
}

export function buildAction(
  input: ActionInput,
  ids: IdGenerator = randomIdGenerator,
): ActionEntity {
  const action: ActionEntity = {
    type: 'action',
    id: ids('action'),
    definitionId: input.definitionId,
    connectionId: input.connectionId,
    options: toOptions(input.options),
    children: {},
  };
  if (input.headline !== undefined) action.headline = input.headline;
  if (input.disabled !== undefined) action.disabled = input.disabled;
  return action;
}

function buildFeedback(
  input: FeedbackInput,
  targets: { backgroundId: string; textId: string },
  ids: IdGenerator,
): FeedbackEntity {
  const overrides: StyleOverride[] = [];
  const style = input.style ?? {};
  const push = (elementId: string, property: string, override: StyleOverride['override']): void => {
    overrides.push({
      overrideId: ids('override'),
      elementId,
      elementProperty: property,
      override,
    });
  };
  if (style.bgColor !== undefined) push(targets.backgroundId, 'color', val(style.bgColor));
  if (style.textColor !== undefined) push(targets.textId, 'color', val(style.textColor));
  if (style.bgFromResult !== undefined)
    push(targets.backgroundId, 'color', val(style.bgFromResult));
  if (style.textFromResult !== undefined) push(targets.textId, 'color', val(style.textFromResult));

  const feedback: FeedbackEntity = {
    type: 'feedback',
    id: ids('feedback'),
    definitionId: input.definitionId,
    connectionId: input.connectionId,
    options: toOptions(input.options),
    isInverted: val(input.isInverted ?? false),
    styleOverrides: overrides,
    children: {},
  };
  if (input.headline !== undefined) feedback.headline = input.headline;
  return feedback;
}

// ---------------------------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------------------------

export interface ButtonInput {
  /** Static button text. Use `textExpression` for an expression. */
  text?: string;
  /** Expression for the text, for example `` `CAM ${$(atem:input1_long_name)}` ``. Wins over `text`. */
  textExpression?: string;
  bgColor?: number | string;
  textColor?: number | string;
  fontSize?: number;
  /** Let Companion shrink the text to fit (`fontsizeAllowShrink`). Default `false`, like the measured sample. */
  fontSizeAllowShrink?: boolean;
  notes?: string;
  /** Actions run on press (`down`). */
  actions?: ActionInput[];
  /** Actions run on release (`up`). */
  actionsUp?: ActionInput[];
  feedbacks?: FeedbackInput[];
  ids?: IdGenerator;
}

/** Layered button with the three layers every Companion button starts with: canvas, background box, text. */
export function buildButton(input: ButtonInput = {}): LayeredButton {
  const ids = input.ids ?? randomIdGenerator;
  const canvasId = ids('element');
  const backgroundId = ids('element');
  const textId = ids('element');

  const canvas = {
    type: 'canvas' as const,
    id: canvasId,
    name: 'Canvas',
    usage: 'auto' as const,
    decoration: val('default' as const),
    showStatusIcons: val('default' as const),
  };

  const background: BoxLayer = {
    type: 'box',
    id: backgroundId,
    name: 'Background',
    usage: 'auto',
    pinnedProperties: ['color'],
    enabled: val(true),
    opacity: val(100),
    x: val(0),
    y: val(0),
    width: val(100),
    height: val(100),
    rotation: val(0),
    color: val(input.bgColor ?? 0),
    cornerRadius: val(0),
    borderWidth: val(0),
    borderColor: val(0),
    borderPosition: val('inside'),
  };

  const text: TextLayer = {
    type: 'text',
    id: textId,
    name: 'Text',
    usage: 'auto',
    pinnedProperties: ['text', 'fontsize', 'fontsizeAllowShrink', 'color', 'halign', 'valign'],
    enabled: val(true),
    opacity: val(100),
    x: val(0),
    y: val(0),
    width: val(100),
    height: val(100),
    rotation: val(0),
    text: input.textExpression !== undefined ? expr(input.textExpression) : val(input.text ?? ''),
    fontsize: val(input.fontSize ?? 18),
    fontsizeAllowShrink: val(input.fontSizeAllowShrink ?? false),
    font: val('companion-sans'),
    weight: val('normal'),
    styles: val([]),
    color: val(input.textColor ?? 0xffffff),
    outlineColor: val(0xff000000),
    halign: val('center'),
    valign: val('center'),
  };

  return {
    type: 'button-layered',
    options: {
      stepProgression: 'auto',
      stepExpression: '',
      rotaryActions: false,
      canModifyStyleInApis: false,
      notes: input.notes ?? '',
    },
    style: { layers: [canvas, background, text] },
    steps: {
      '0': {
        action_sets: {
          down: (input.actions ?? []).map((a) => buildAction(a, ids)),
          up: (input.actionsUp ?? []).map((a) => buildAction(a, ids)),
        },
        options: { runWhileHeld: [] },
      },
    },
    feedbacks: (input.feedbacks ?? []).map((f) => buildFeedback(f, { backgroundId, textId }, ids)),
    localVariables: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------

export interface PlacedControl {
  /** 0-based row. */
  row: number;
  /** 0-based column. */
  column: number;
  control: Control;
}

export interface PageExportInput {
  name: string;
  controls: PlacedControl[];
  /** Connections used by the controls, keyed by the connection ID that the entities reference. */
  instances?: Record<string, ExportInstance>;
  /** Page number the content comes from; Companion lets the importer choose the target. Default 1. */
  oldPageNumber?: number;
  /** Explicit grid. Default: the default 8x4 grid, grown to fit all controls. */
  gridSize?: GridSize;
  /**
   * Add Companion's standard navigation buttons (page up, page number, page down at column 0, rows 0 to 2).
   * Default `false`: a replaced page then loses them, so enable it when navigation on the page is wanted.
   */
  navigation?: boolean;
  companionBuild?: string;
  notes?: string;
  /** Stable page ID; omitted by default (Companion assigns one). */
  pageId?: string;
}

/** Grid that contains the default 8x4 grid and every given position. */
export function fitGrid(positions: Array<{ row: number; column: number }>): GridSize {
  const grid: GridSize = { ...DEFAULT_GRID_SIZE };
  for (const { row, column } of positions) {
    if (column < grid.minColumn) grid.minColumn = column;
    if (column > grid.maxColumn) grid.maxColumn = column;
    if (row < grid.minRow) grid.minRow = row;
    if (row > grid.maxRow) grid.maxRow = row;
  }
  return grid;
}

function placeControls(
  placed: PlacedControl[],
  context: string,
): Record<string, Record<string, Control>> {
  const controls: Record<string, Record<string, Control>> = {};
  for (const { row, column, control } of placed) {
    if (!Number.isInteger(row) || !Number.isInteger(column)) {
      throw new Error(`${context}: position ${row}/${column} must be integers`);
    }
    const rowKey = String(row);
    const columnKey = String(column);
    const rowObject = (controls[rowKey] ??= {});
    if (columnKey in rowObject) {
      throw new Error(`${context}: duplicate control at row ${row}, column ${column}`);
    }
    rowObject[columnKey] = control;
  }
  return controls;
}

export function buildPageExport(input: PageExportInput): PageExport {
  const placed = [...input.controls];
  if (input.navigation === true) {
    placed.push(
      { row: 0, column: 0, control: { type: 'pageup' } },
      { row: 1, column: 0, control: { type: 'pagenum' } },
      { row: 2, column: 0, control: { type: 'pagedown' } },
    );
  }
  const controls = placeControls(placed, `Page "${input.name}"`);

  const page: PageExport['page'] = {
    name: input.name,
    controls,
    gridSize: input.gridSize ?? fitGrid(placed),
  };
  if (input.pageId !== undefined) page.id = input.pageId;

  const result: PageExport = {
    version: FILE_VERSION,
    type: 'page',
    page,
    instances: input.instances ?? {},
    connectionCollections: [],
    oldPageNumber: input.oldPageNumber ?? 1,
    imageLibrary: [],
    imageLibraryCollections: [],
  };
  if (input.companionBuild !== undefined) result.companionBuild = input.companionBuild;
  if (input.notes !== undefined) result.notes = input.notes;
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------------------------------------------

export interface TriggerEventInput {
  /** Companion event type, for example `startup`, `interval`, `variable_changed`. */
  type: string;
  /** Raw JSON option values (event options are not wrapped). */
  options?: Record<string, JsonLike | undefined>;
  enabled?: boolean;
  headline?: string;
}

export interface TriggerInput {
  /** Key of the trigger in the export (without the `trigger:` prefix). Generated if omitted. */
  id?: string;
  name: string;
  /** Companion creates triggers disabled; default `false` here as well. */
  enabled?: boolean;
  sortOrder?: number;
  collectionId?: string;
  notes?: string;
  events?: TriggerEventInput[];
  /** Boolean feedbacks; all must be true (not verified in the Companion source, see research notes). */
  condition?: FeedbackInput[];
  actions?: ActionInput[];
}

export interface TriggerExportInput {
  triggers: TriggerInput[];
  collections?: TriggerCollection[];
  instances?: Record<string, ExportInstance>;
  companionBuild?: string;
  notes?: string;
  ids?: IdGenerator;
}

export function buildTrigger(input: TriggerInput, ids: IdGenerator = randomIdGenerator): Trigger {
  const options: Trigger['options'] = {
    name: input.name,
    enabled: input.enabled ?? false,
    sortOrder: input.sortOrder ?? 0,
  };
  if (input.collectionId !== undefined) options.collectionId = input.collectionId;
  if (input.notes !== undefined) options.notes = input.notes;

  const events: TriggerEvent[] = (input.events ?? []).map((event) => {
    const built: TriggerEvent = {
      id: ids('event'),
      type: event.type,
      enabled: event.enabled ?? true,
      options: (event.options ?? {}) as TriggerEvent['options'],
    };
    if (event.headline !== undefined) built.headline = event.headline;
    return built;
  });

  return {
    type: 'trigger',
    options,
    events,
    // Conditions are feedback entities without style overrides.
    condition: (input.condition ?? []).map((c) => {
      const feedback = buildFeedback(c, { backgroundId: '', textId: '' }, ids);
      delete feedback.styleOverrides;
      return feedback;
    }),
    actions: (input.actions ?? []).map((a) => buildAction(a, ids)),
    localVariables: [],
  };
}

export function buildTriggerExport(input: TriggerExportInput): TriggerExport {
  const ids = input.ids ?? randomIdGenerator;
  const triggers: Record<string, Trigger> = {};
  for (const trigger of input.triggers) {
    const key = trigger.id ?? ids('trigger');
    if (key in triggers) throw new Error(`Duplicate trigger id "${key}"`);
    triggers[key] = buildTrigger(trigger, ids);
  }
  const result: TriggerExport = {
    version: FILE_VERSION,
    type: 'trigger_list',
    triggers,
    triggerCollections: input.collections ?? [],
    instances: input.instances ?? {},
    connectionCollections: [],
  };
  if (input.companionBuild !== undefined) result.companionBuild = input.companionBuild;
  if (input.notes !== undefined) result.notes = input.notes;
  return result;
}
