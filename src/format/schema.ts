/**
 * Zod schemas for the Bitfocus Companion export format as written by Companion 5.0.0 to 5.1.3
 * (`FILE_VERSION = 12`).
 *
 * Source of truth (read, not guessed): Companion v5.1.3, `shared-lib/lib/Model/{ButtonModel,EntityModel,
 * StyleLayersModel,StyleModel,ExportModel,TriggerModel,ActionModel,Options,Instance}.ts` and the import code in
 * `companion/lib/ImportExport/{Import,ImportFixup,Controller}.ts`. 5.1.3 ships TypeScript types for the export, not
 * Zod schemas, so these schemas are a hand translation of those types.
 *
 * Design notes:
 * - The schemas describe what Companion can read. Rules that the *project* enforces on top of that (version must be
 *   12, `updatePolicy` must be present, no legacy controls, ...) live in `validate.ts`, so that every violation gets a
 *   stable, specific issue code.
 * - Objects are loose (unknown keys are preserved) because real exports carry more fields than this subset models.
 *   `validate.ts` reports unknown keys on controls, entities and layers as warnings.
 * - Recursive structures (entity `children`, group-layer `children`) are validated recursively with `superRefine`.
 */
import { z } from 'zod';

/** Export file version written by Companion 5.0.0 to 5.1.3 (measured on 5.1.3, see docs/architecture.md). */
export const FILE_VERSION = 12;

/** Companion's default grid (columns 0..7, rows 0..3). */
export const DEFAULT_GRID_SIZE = { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 } as const;

// ---------------------------------------------------------------------------------------------------------------
// Option wrapper: every option, layer property and `isInverted` is `{ isExpression, value }`
// ---------------------------------------------------------------------------------------------------------------

/** Wraps a value schema into Companion's `ExpressionOrValue` (`shared-lib/lib/Model/Options.ts`). */
export function expressionOrValue<T extends z.ZodType>(valueSchema: T) {
  return z.union([
    z.object({ isExpression: z.literal(false), value: valueSchema }),
    z.object({ isExpression: z.literal(true), value: z.string() }),
  ]);
}

const JsonValueSchema = z.json();

/** `ExpressionOrValue<JsonValue | undefined>` as used for action/feedback options. */
export const ExpressionOrJsonValueSchema = expressionOrValue(JsonValueSchema.optional());

export type ExpressionOrJsonValue = z.infer<typeof ExpressionOrJsonValueSchema>;

/** The `options` object of an action or feedback entity. */
export const OptionsObjectSchema = z.record(z.string(), ExpressionOrJsonValueSchema.optional());

export type OptionsObject = z.infer<typeof OptionsObjectSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Graphics layers (`style.layers`)
// ---------------------------------------------------------------------------------------------------------------

const ev = expressionOrValue;

export const LayerUsageSchema = z.enum(['auto', 'text', 'color', 'image', 'leds']);
const ColorValueSchema = z.union([z.number(), z.string()]);
const HAlignSchema = z.enum(['left', 'center', 'right']);
const VAlignSchema = z.enum(['top', 'center', 'bottom']);
const BorderPositionSchema = z.enum(['inside', 'center', 'outside']);

const layerBase = {
  id: z.string(),
  name: z.string(),
  usage: LayerUsageSchema,
  enabled: ev(z.boolean()),
  opacity: ev(z.number()),
  /** Optional: the 5.1 migration adds default pinned properties when missing (measured, test A2). */
  pinnedProperties: z.array(z.string()).optional(),
};

const bounds = {
  x: ev(z.number()),
  y: ev(z.number()),
  width: ev(z.number()),
  height: ev(z.number()),
};

const rotation = { rotation: ev(z.number()) };

const border = {
  borderWidth: ev(z.number()),
  borderColor: ev(ColorValueSchema),
  borderPosition: ev(BorderPositionSchema),
};

/** The background element. It has no `enabled`, `opacity` or `pinnedProperties` and must be the first layer. */
export const CanvasLayerSchema = z.looseObject({
  type: z.literal('canvas'),
  id: z.string(),
  name: z.string(),
  usage: LayerUsageSchema,
  decoration: ev(z.enum(['default', 'topbar', 'border', 'none'])),
  showStatusIcons: ev(z.enum(['default', 'all', 'none'])),
});

export const BoxLayerSchema = z.looseObject({
  type: z.literal('box'),
  ...layerBase,
  ...bounds,
  ...rotation,
  ...border,
  color: ev(ColorValueSchema),
  cornerRadius: ev(z.number()),
});

export const TextLayerSchema = z.looseObject({
  type: z.literal('text'),
  ...layerBase,
  ...bounds,
  ...rotation,
  text: ev(z.string()),
  fontsize: ev(z.number()),
  fontsizeAllowShrink: ev(z.boolean()),
  font: ev(z.enum(['companion-sans', 'companion-mono'])),
  weight: ev(z.enum(['normal', 'bold'])),
  styles: ev(z.array(z.enum(['italic', 'underline', 'strikethrough']))),
  color: ev(ColorValueSchema),
  outlineColor: ev(ColorValueSchema),
  halign: ev(HAlignSchema),
  valign: ev(VAlignSchema),
});

export const ImageLayerSchema = z.looseObject({
  type: z.literal('image'),
  ...layerBase,
  ...bounds,
  ...rotation,
  base64Image: ev(z.string().nullable()),
  halign: ev(HAlignSchema),
  valign: ev(VAlignSchema),
  fillMode: ev(z.enum(['fit', 'fill', 'crop'])),
});

export const LineLayerSchema = z.looseObject({
  type: z.literal('line'),
  ...layerBase,
  fromX: ev(z.number()),
  fromY: ev(z.number()),
  toX: ev(z.number()),
  toY: ev(z.number()),
  borderWidth: ev(z.number()),
  borderColor: ev(ColorValueSchema),
  borderPosition: ev(z.enum(['left', 'center', 'right'])),
});

export const CircleLayerSchema = z.looseObject({
  type: z.literal('circle'),
  ...layerBase,
  ...bounds,
  ...border,
  color: ev(ColorValueSchema),
  startAngle: ev(z.number()),
  endAngle: ev(z.number()),
  drawSlice: ev(z.boolean()),
  borderOnlyArc: ev(z.boolean()),
});

/** Children of a group are validated recursively by `validateExport` (they are full layers). */
export const GroupLayerSchema = z.looseObject({
  type: z.literal('group'),
  ...layerBase,
  ...bounds,
  ...rotation,
  squareCoords: ev(z.boolean()),
  children: z.array(z.looseObject({ type: z.string() })),
});

export const ReferenceLayerSchema = z.looseObject({
  type: z.literal('reference'),
  ...layerBase,
  ...bounds,
  ...rotation,
  location: ev(z.string()),
});

/** Composite elements carry module-defined options under `opt:<name>` keys (kept via the loose object). */
export const CompositeLayerSchema = z.looseObject({
  type: z.literal('composite'),
  ...layerBase,
  ...bounds,
  ...rotation,
  connectionId: z.string(),
  elementId: z.string(),
});

export const GaugeLayerSchema = z.looseObject({
  type: z.literal('gauge'),
  ...layerBase,
  ...bounds,
  ...rotation,
  value: ev(z.number()),
  min: ev(z.number()),
  max: ev(z.number()),
  origin: ev(z.number().nullable()),
  symmetric: ev(z.boolean()),
  orientation: ev(z.enum(['horizontal', 'vertical', 'ring'])),
  reverse: ev(z.boolean()),
  startAngle: ev(z.number()),
  endAngle: ev(z.number()),
  ringWidth: ev(z.number()),
  roundedEnds: ev(z.boolean()),
  fillEnabled: ev(z.boolean()),
  multiColour: ev(z.boolean()),
  fillWidth: ev(z.number()),
  stops: ev(z.array(z.record(z.string(), JsonValueSchema))),
  markerEnabled: ev(z.boolean()),
  markerColor: ev(ColorValueSchema),
  markerWidth: ev(z.number()),
  trackStyle: ev(z.enum(['transparent', 'dimmed'])),
  trackAmount: ev(z.number()),
  trackWidth: ev(z.number()),
});

export const ButtonLayerSchema = z.discriminatedUnion('type', [
  CanvasLayerSchema,
  BoxLayerSchema,
  TextLayerSchema,
  ImageLayerSchema,
  LineLayerSchema,
  CircleLayerSchema,
  GroupLayerSchema,
  ReferenceLayerSchema,
  CompositeLayerSchema,
  GaugeLayerSchema,
]);

export type ButtonLayer = z.infer<typeof ButtonLayerSchema>;
export type CanvasLayer = z.infer<typeof CanvasLayerSchema>;
export type BoxLayer = z.infer<typeof BoxLayerSchema>;
export type TextLayer = z.infer<typeof TextLayerSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Entities: actions, feedbacks, local variables
// ---------------------------------------------------------------------------------------------------------------

export const StyleOverrideSchema = z.object({
  overrideId: z.string(),
  elementId: z.string(),
  elementProperty: z.string(),
  /**
   * Boolean feedback: the value to apply. Advanced feedback: `{ isExpression: false, value: '<property name in the
   * module result>' }` (for example `'bgcolor'`). Value feedback: an expression using `$(this:value)`.
   */
  override: ExpressionOrJsonValueSchema,
});

export type StyleOverride = z.infer<typeof StyleOverrideSchema>;

const storeResultString = expressionOrValue(z.string());

export const StoreResultSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local-variable'),
    location: storeResultString,
    variableName: storeResultString,
  }),
  z.object({
    type: z.literal('page-variable'),
    page: storeResultString,
    variableName: storeResultString,
  }),
  z.object({
    type: z.literal('custom-variable'),
    variableName: storeResultString,
    createIfNotExists: z.boolean(),
  }),
]);

const entityBase = {
  id: z.string(),
  definitionId: z.string(),
  /** `'internal'` for Companion's own actions/feedbacks, otherwise a key of the file's `instances`. */
  connectionId: z.string(),
  headline: z.string().optional(),
  options: OptionsObjectSchema,
  disabled: z.boolean().optional(),
  /** Ignored on import: entities inherit `lastUpgradeIndex` of their connection (measured). */
  upgradeIndex: z.number().optional(),
  /** Only used by internal entities (`logic_if` and friends); validated recursively. */
  children: z.record(z.string(), z.array(z.unknown()).optional()).optional(),
};

/** Validates the children of an entity as entities themselves (recursive). */
function refineChildren(
  value: { children?: Record<string, unknown[] | undefined> | undefined },
  ctx: z.RefinementCtx,
): void {
  for (const [group, list] of Object.entries(value.children ?? {})) {
    (list ?? []).forEach((child, index) => {
      const result = EntitySchema.safeParse(child);
      if (result.success) return;
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: 'custom',
          message: issue.message,
          path: ['children', group, index, ...issue.path],
        });
      }
    });
  }
}

export const ActionEntitySchema = z
  .looseObject({
    type: z.literal('action'),
    ...entityBase,
    storeResult: StoreResultSchema.optional(),
  })
  .superRefine(refineChildren);

export const FeedbackEntitySchema = z
  .looseObject({
    type: z.literal('feedback'),
    ...entityBase,
    isInverted: expressionOrValue(z.boolean()).optional(),
    /** Only on entities in a `localVariables` list. */
    variableName: z.string().optional(),
    styleOverrides: z.array(StyleOverrideSchema).optional(),
  })
  .superRefine(refineChildren);

export const EntitySchema = z.discriminatedUnion('type', [
  ActionEntitySchema,
  FeedbackEntitySchema,
]);

export type ActionEntity = z.infer<typeof ActionEntitySchema>;
export type FeedbackEntity = z.infer<typeof FeedbackEntitySchema>;
export type Entity = z.infer<typeof EntitySchema>;

// ---------------------------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------------------------

/** `down`, `up`, `rotate_left`, `rotate_right`, or a hold duration in ms as numeric string (`'500'`). */
export const ActionSetsSchema = z.record(z.string(), z.array(EntitySchema).optional());

export const StepSchema = z.object({
  action_sets: ActionSetsSchema,
  options: z.object({
    runWhileHeld: z.array(z.number()),
    name: z.string().optional(),
  }),
});

export const LayeredButtonOptionsSchema = z.object({
  stepProgression: z.enum(['auto', 'manual', 'expression']),
  stepExpression: z.string().optional(),
  rotaryActions: z.boolean(),
  canModifyStyleInApis: z.boolean(),
  notes: z.string().optional(),
});

export type LayeredButtonOptions = z.infer<typeof LayeredButtonOptionsSchema>;

const layeredCommon = {
  options: LayeredButtonOptionsSchema,
  style: z.object({ layers: z.array(ButtonLayerSchema) }),
  steps: z.record(z.string(), StepSchema),
  feedbacks: z.array(EntitySchema),
  localVariables: z.array(EntitySchema),
};

/** The only normal button type of Companion 5.x. The legacy `button` type is rejected by `validateExport`. */
export const LayeredButtonSchema = z.looseObject({
  type: z.literal('button-layered'),
  ...layeredCommon,
});

/** Linked preset (since 5.1.0). Modelled for reading existing exports; the builders do not create it. */
export const PresetReferenceButtonSchema = z.looseObject({
  type: z.literal('preset-reference'),
  ...layeredCommon,
  presetRef: z.object({
    connectionId: z.string(),
    moduleId: z.string(),
    presetId: z.string(),
    variableValues: z.record(z.string(), z.unknown()).nullable(),
  }),
  checksum: z.string().optional(),
});

/** Mirrors another button (since 5.1.0). */
export const ButtonReferenceButtonSchema = z.looseObject({
  type: z.literal('button-reference'),
  options: z.looseObject({
    location: expressionOrValue(z.string()),
    notes: z.string().optional(),
  }),
});

export const PageNumberButtonSchema = z.looseObject({ type: z.literal('pagenum') });
export const PageUpButtonSchema = z.looseObject({ type: z.literal('pageup') });
export const PageDownButtonSchema = z.looseObject({ type: z.literal('pagedown') });

export const ControlSchema = z.discriminatedUnion('type', [
  LayeredButtonSchema,
  PresetReferenceButtonSchema,
  ButtonReferenceButtonSchema,
  PageNumberButtonSchema,
  PageUpButtonSchema,
  PageDownButtonSchema,
]);

export type LayeredButton = z.infer<typeof LayeredButtonSchema>;
export type Control = z.infer<typeof ControlSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Connections (`instances`)
// ---------------------------------------------------------------------------------------------------------------

export const UpdatePolicySchema = z.enum(['manual', 'stable', 'beta']);
export type UpdatePolicy = z.infer<typeof UpdatePolicySchema>;

/**
 * A connection entry. In page and trigger exports only the minimal fields exist; full exports add `config`, `secrets`,
 * `enabled`, `isFirstInit` (kept via the loose object). `updatePolicy` and `lastUpgradeIndex` are optional for
 * Companion but `validateExport` requires `updatePolicy` (missing => REST v2 `GET /connections/v1` fails with 500).
 */
export const ExportInstanceSchema = z.looseObject({
  label: z.string(),
  moduleId: z.string(),
  lastUpgradeIndex: z.number().optional(),
  moduleVersionId: z.string().nullable().optional(),
  updatePolicy: UpdatePolicySchema.optional(),
  sortOrder: z.number().optional(),
  collectionId: z.string().optional(),
});

export type ExportInstance = z.infer<typeof ExportInstanceSchema>;

export const ExportInstancesSchema = z.record(z.string(), ExportInstanceSchema);

// ---------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------

export const GridSizeSchema = z.object({
  minColumn: z.number().int(),
  maxColumn: z.number().int(),
  minRow: z.number().int(),
  maxRow: z.number().int(),
});

export type GridSize = z.infer<typeof GridSizeSchema>;

/** `controls[row][column]`, both 0-based and stringified. */
export const PageControlsSchema = z.record(z.string(), z.record(z.string(), ControlSchema));

export const ExportPageContentSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  controls: PageControlsSchema,
  pageVariables: z.array(EntitySchema).optional(),
  gridSize: GridSizeSchema,
});

export type ExportPageContent = z.infer<typeof ExportPageContentSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------------------------------------------

export const TriggerOptionsSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  sortOrder: z.number(),
  collectionId: z.string().optional(),
  notes: z.string().optional(),
});

export const TriggerEventSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  enabled: z.boolean(),
  headline: z.string().optional(),
  /** Event options are raw JSON values, not wrapped (unlike action options). */
  options: z.record(z.string(), JsonValueSchema.optional()),
});

export const TriggerSchema = z.looseObject({
  type: z.literal('trigger'),
  options: TriggerOptionsSchema,
  actions: z.array(EntitySchema),
  condition: z.array(EntitySchema),
  events: z.array(TriggerEventSchema),
  localVariables: z.array(EntitySchema),
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggerEvent = z.infer<typeof TriggerEventSchema>;

export const TriggerCollectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  sortOrder: z.number(),
  get children() {
    return z.array(TriggerCollectionSchema);
  },
  metaData: z.object({ enabled: z.boolean() }),
});

export type TriggerCollection = z.infer<typeof TriggerCollectionSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Export files
// ---------------------------------------------------------------------------------------------------------------

const exportHead = {
  version: z.number().int(),
  companionBuild: z.string().optional(),
  notes: z.string().optional(),
};

export const PageExportSchema = z.looseObject({
  ...exportHead,
  type: z.literal('page'),
  page: ExportPageContentSchema,
  instances: ExportInstancesSchema,
  connectionCollections: z.array(z.unknown()).optional(),
  oldPageNumber: z.number().int(),
});

export const TriggerExportSchema = z.looseObject({
  ...exportHead,
  type: z.literal('trigger_list'),
  triggers: z.record(z.string(), TriggerSchema),
  triggerCollections: z.array(TriggerCollectionSchema).optional(),
  instances: ExportInstancesSchema,
  connectionCollections: z.array(z.unknown()).optional(),
});

/**
 * Subset of the full export: pages, connections (`instances`) and triggers. Everything else a full export carries
 * (surfaces, custom variables, image library, ...) is preserved but not modelled.
 */
export const FullExportSchema = z.looseObject({
  ...exportHead,
  type: z.literal('full'),
  pages: z.record(z.string(), ExportPageContentSchema).optional(),
  instances: ExportInstancesSchema.optional(),
  triggers: z.record(z.string(), TriggerSchema).optional(),
  triggerCollections: z.array(TriggerCollectionSchema).optional(),
  connectionCollections: z.array(z.unknown()).optional(),
});

export const ExportFileSchema = z.discriminatedUnion('type', [
  PageExportSchema,
  TriggerExportSchema,
  FullExportSchema,
]);

export type PageExport = z.infer<typeof PageExportSchema>;
export type TriggerExport = z.infer<typeof TriggerExportSchema>;
export type FullExport = z.infer<typeof FullExportSchema>;
export type ExportFile = z.infer<typeof ExportFileSchema>;
