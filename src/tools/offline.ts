import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  findAction,
  findFeedback,
  getModule,
  listModules,
  searchModules,
  supportsExpressions,
} from '../catalog/index.js';
import {
  atemSwitcherPage,
  birddogPresetPage,
  buildButton,
  buildConnection,
  buildPageExport,
  videohubRoutingPage,
  validateExport,
  vmixInputPage,
  type ActionInput,
  type AtemSwitcherPageOptions,
  type BirddogPresetPageOptions,
  type ExportInstance,
  type FeedbackInput,
  type PlacedControl,
  type TemplateConnection,
  type VideohubRoutingPageOptions,
  type VmixInputPageOptions,
  type ValidationResult,
} from '../format/index.js';
import { catalogLookup } from './catalog-adapter.js';
import { defineTool, readOnly } from './define.js';
import { failure, success } from './result.js';
import {
  ColorNumber,
  ColorSchema,
  CountOrListSchema,
  GridSchema,
  JsonObjectSchema,
  TemplateCommon,
  TemplateConnectionSchema,
} from './schemas.js';

const OFFLINE_NOTE = 'Offline: no connection to Companion is made, nothing is written.';

function validationBody(result: ValidationResult): Record<string, unknown> {
  return { valid: result.ok, errors: result.errors, warnings: result.warnings };
}

/** Result for tools that build an export: `ok` follows the validation, the export is always returned for inspection. */
function exportResult(file: unknown, result: ValidationResult) {
  if (result.ok) return success({ export: file, ...validationBody(result) });
  return failure(
    {
      code: 'VALIDATION_FAILED',
      message: `The generated export has ${result.errors.length} validation error(s).`,
      source: 'validation',
    },
    { export: file, ...validationBody(result) },
  );
}

function closeIds(ids: string[], wanted: string): string[] {
  const needle = wanted.toLowerCase();
  return ids.filter((id) => id.toLowerCase().includes(needle)).slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------
// Template parameters (strict, per template)
// ---------------------------------------------------------------------------------------------------------------

const AtemParams = z.strictObject({
  ...TemplateCommon,
  inputs: CountOrListSchema,
  mixEffect: z.number().int().min(1).optional(),
  programColor: ColorNumber.optional(),
  previewColor: ColorNumber.optional(),
  programTextColor: ColorNumber.optional(),
  previewTextColor: ColorNumber.optional(),
  transitions: z.boolean().optional(),
  columns: z.number().int().min(1).optional(),
});

const VideohubParams = z.strictObject({
  ...TemplateCommon,
  inputs: CountOrListSchema,
  outputs: CountOrListSchema,
  routedColor: ColorNumber.optional(),
  routedTextColor: ColorNumber.optional(),
  labelColor: ColorNumber.optional(),
  ignoreLock: z.boolean().optional(),
});

const VmixParams = z.strictObject({
  ...TemplateCommon,
  inputs: z.union([
    z.number().int().min(1),
    z
      .array(
        z.union([
          z.number().int(),
          z.string(),
          z.strictObject({
            input: z.union([z.number().int(), z.string()]),
            label: z.string().optional(),
          }),
        ]),
      )
      .min(1),
  ]),
  mix: z.union([z.number().int().min(1).max(16), z.literal('Selected')]).optional(),
  programColor: ColorNumber.optional(),
  previewColor: ColorNumber.optional(),
  tallyTextColor: ColorNumber.optional(),
  programRow: z.boolean().optional(),
  columns: z.number().int().min(1).optional(),
});

const BirddogParams = z.strictObject({
  ...TemplateCommon,
  presets: CountOrListSchema,
  buttonColor: ColorNumber.optional(),
  columns: z.number().int().min(1).optional(),
});

const TEMPLATES = ['atem', 'videohub', 'vmix', 'birddog'] as const;
type TemplateName = (typeof TEMPLATES)[number];

/**
 * Resolves the connection default (`id` = label) and removes `undefined` properties. Zod types optional keys as
 * `key?: T | undefined`, which `exactOptionalPropertyTypes` rejects for the template options. The JSON round trip
 * drops exactly those keys, so the cast to the options type is sound.
 */
function toOptions<O>(params: { connection: z.infer<typeof TemplateConnectionSchema> }): O {
  const { connection, ...rest } = params;
  const resolved: TemplateConnection = {
    id: connection.id ?? connection.label,
    label: connection.label,
  };
  if (connection.updatePolicy !== undefined) resolved.updatePolicy = connection.updatePolicy;
  return JSON.parse(JSON.stringify({ ...rest, connection: resolved })) as O;
}

/** Drops `undefined` properties so the result fits `exactOptionalPropertyTypes` option types. */
function compact<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function generateTemplate(template: TemplateName, rawParams: unknown) {
  switch (template) {
    case 'atem':
      return atemSwitcherPage(toOptions<AtemSwitcherPageOptions>(AtemParams.parse(rawParams)));
    case 'videohub':
      return videohubRoutingPage(
        toOptions<VideohubRoutingPageOptions>(VideohubParams.parse(rawParams)),
      );
    case 'vmix':
      return vmixInputPage(toOptions<VmixInputPageOptions>(VmixParams.parse(rawParams)));
    case 'birddog':
      return birddogPresetPage(toOptions<BirddogPresetPageOptions>(BirddogParams.parse(rawParams)));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// build_page specification
// ---------------------------------------------------------------------------------------------------------------

const ActionSpec = z.strictObject({
  connection: z
    .string()
    .min(1)
    .describe('Label of an entry of `connections`, or "internal" for Companion\'s own actions.'),
  actionId: z.string().min(1),
  options: JsonObjectSchema.default({}).describe(
    'Option values by option id. Plain values are wrapped as { isExpression: false, value }; pass { isExpression: true, value: "<expression>" } for expressions.',
  ),
  headline: z.string().optional(),
  disabled: z.boolean().optional(),
});

const FeedbackSpec = z.strictObject({
  connection: z.string().min(1),
  feedbackId: z.string().min(1),
  options: JsonObjectSchema.default({}),
  isInverted: z.boolean().optional(),
  headline: z.string().optional(),
  style: z
    .strictObject({
      bgColor: ColorSchema.optional(),
      textColor: ColorSchema.optional(),
      bgFromResult: z.string().optional(),
      textFromResult: z.string().optional(),
    })
    .optional(),
});

const ButtonSpec = z.strictObject({
  row: z.number().int(),
  column: z.number().int(),
  text: z.string().optional(),
  textExpression: z.string().optional(),
  colors: z
    .strictObject({ background: ColorSchema.optional(), text: ColorSchema.optional() })
    .optional(),
  fontSize: z.number().int().min(1).max(200).optional(),
  notes: z.string().optional(),
  actions: z.array(ActionSpec).default([]),
  actionsUp: z.array(ActionSpec).optional(),
  feedbacks: z.array(FeedbackSpec).default([]),
});

const ConnectionSpec = z.strictObject({
  label: z.string().min(1),
  moduleId: z.string().min(1),
  updatePolicy: z.enum(['manual', 'stable', 'beta']).optional(),
});

const BuildPageInput = z.strictObject({
  pageName: z.string().min(1),
  grid: GridSchema.optional().describe('Default: the 8x4 grid, grown to fit all buttons.'),
  navigation: z
    .boolean()
    .optional()
    .describe('Add Companion page up/number/down buttons at column 0, rows 0 to 2.'),
  connections: z.array(ConnectionSpec).default([]),
  buttons: z.array(ButtonSpec).min(1),
});

type ActionSpecT = z.output<typeof ActionSpec>;
type FeedbackSpecT = z.output<typeof FeedbackSpec>;

function toAction(spec: ActionSpecT): ActionInput {
  const action: ActionInput = {
    connectionId: spec.connection,
    definitionId: spec.actionId,
    options: spec.options,
  };
  if (spec.headline !== undefined) action.headline = spec.headline;
  if (spec.disabled !== undefined) action.disabled = spec.disabled;
  return action;
}

function toFeedback(spec: FeedbackSpecT): FeedbackInput {
  const feedback: FeedbackInput = {
    connectionId: spec.connection,
    definitionId: spec.feedbackId,
    options: spec.options,
  };
  if (spec.isInverted !== undefined) feedback.isInverted = spec.isInverted;
  if (spec.headline !== undefined) feedback.headline = spec.headline;
  if (spec.style !== undefined) feedback.style = compact(spec.style);
  return feedback;
}

export function registerOfflineTools(server: McpServer): void {
  defineTool(server, {
    name: 'catalog_search',
    title: 'Search the module catalog',
    description:
      `Searches the offline catalog of Companion modules by id, repository, manufacturer, product or keyword (all terms must match). ${OFFLINE_NOTE} ` +
      'Modules with kind "full" have action and feedback data; "index-only" modules are only listed.',
    input: z.strictObject({
      query: z
        .string()
        .max(200)
        .describe('Search terms, e.g. "blackmagic atem". Blank lists all modules.'),
      limit: z.number().int().min(1).max(200).default(25),
    }),
    annotations: readOnly('Search the module catalog', false),
    run: async ({ query, limit }) => {
      const hits = query.trim() === '' ? listModules() : searchModules(query);
      return success({
        total: hits.length,
        returned: Math.min(hits.length, limit),
        modules: hits.slice(0, limit).map((entry) => ({
          moduleId: entry.moduleId,
          kind: entry.kind,
          repo: entry.repo,
          version: entry.version,
          ...(entry.manufacturer === undefined ? {} : { manufacturer: entry.manufacturer }),
          ...(entry.products === undefined ? {} : { products: entry.products }),
          ...(entry.note === undefined ? {} : { note: entry.note }),
        })),
      });
    },
  });

  defineTool(server, {
    name: 'catalog_module',
    title: 'Show a catalogued module',
    description:
      `Returns one module of the offline catalog: version, verification status and the list of its actions and feedbacks (id and name; use companion_catalog_action for options). ${OFFLINE_NOTE} ` +
      'The data was read from module source code and is not tested against devices.',
    input: z.strictObject({ moduleId: z.string().min(1) }),
    annotations: readOnly('Show a catalogued module', false),
    run: async ({ moduleId }) => {
      const module = getModule(moduleId);
      if (module !== undefined) {
        return success({
          kind: 'full',
          moduleId: module.moduleId,
          name: module.name,
          repo: module.repo,
          version: module.version,
          baseVersion: module.baseVersion,
          status: module.status,
          coverage: module.coverage,
          optionsSupportExpressions: supportsExpressions(module),
          actions: module.actions.map((a) => ({
            id: a.id,
            name: a.name,
            optionCount: a.options.length,
            ...(a.availability === undefined ? {} : { availability: a.availability }),
          })),
          feedbacks: module.feedbacks.map((f) => ({
            id: f.id,
            name: f.name,
            optionCount: f.options.length,
            ...(f.feedbackType === undefined ? {} : { feedbackType: f.feedbackType }),
          })),
          ...(module.notes === undefined ? {} : { notes: module.notes }),
        });
      }
      const indexed = listModules().find((entry) => entry.moduleId === moduleId);
      if (indexed !== undefined) {
        return success({
          ...indexed,
          message: 'Known module without action and feedback data in the catalog.',
        });
      }
      return failure(
        {
          code: 'MODULE_NOT_FOUND',
          message: `No module "${moduleId}" in the catalog.`,
          source: 'input',
        },
        {
          suggestions: searchModules(moduleId)
            .slice(0, 5)
            .map((entry) => entry.moduleId),
        },
      );
    },
  });

  defineTool(server, {
    name: 'catalog_action',
    title: 'Show an action or feedback definition',
    description: `Returns the full definition (options with types, choices and ranges, provenance) of one action, or of one feedback when feedback is true. ${OFFLINE_NOTE}`,
    input: z.strictObject({
      moduleId: z.string().min(1),
      actionId: z.string().min(1).describe('Action id, or feedback id when `feedback` is true.'),
      feedback: z.boolean().default(false),
    }),
    annotations: readOnly('Show an action or feedback definition', false),
    run: async ({ moduleId, actionId, feedback }) => {
      const module = getModule(moduleId);
      if (module === undefined) {
        return failure({
          code: 'MODULE_NOT_FOUND',
          message: `No catalog data for module "${moduleId}". Use companion_catalog_search.`,
          source: 'input',
        });
      }
      const definition = feedback
        ? findFeedback(moduleId, actionId)
        : findAction(moduleId, actionId);
      if (definition === undefined) {
        const ids = (feedback ? module.feedbacks : module.actions).map((entry) => entry.id);
        return failure(
          {
            code: feedback ? 'FEEDBACK_NOT_FOUND' : 'ACTION_NOT_FOUND',
            message: `Module "${moduleId}" has no catalogued ${feedback ? 'feedback' : 'action'} "${actionId}".`,
            source: 'input',
          },
          { suggestions: closeIds(ids, actionId) },
        );
      }
      return success({
        moduleId,
        kind: feedback ? 'feedback' : 'action',
        optionsSupportExpressions: supportsExpressions(module, definition),
        definition,
      });
    },
  });

  defineTool(server, {
    name: 'validate_config',
    title: 'Validate a Companion export',
    description:
      `Validates an export object (page, trigger_list or full; format version 12) against the project rules and the module catalog: version, legacy "button" controls (silently dropped by Companion), missing updatePolicy, unknown modules/actions/options, grid coordinates. ${OFFLINE_NOTE} ` +
      'ok is false when there are errors; warnings never fail validation.',
    input: z.strictObject({
      config: JsonObjectSchema.describe('The export file as a JSON object.'),
    }),
    annotations: readOnly('Validate a Companion export', false),
    run: async ({ config }) => {
      const result = validateExport(config, { catalog: catalogLookup });
      if (result.ok) return success(validationBody(result));
      return failure(
        {
          code: 'VALIDATION_FAILED',
          message: `${result.errors.length} validation error(s).`,
          source: 'validation',
        },
        validationBody(result),
      );
    },
  });

  defineTool(server, {
    name: 'generate_page',
    title: 'Generate a page from a template',
    description:
      `Generates a page export from a template and validates it against the catalog. ${OFFLINE_NOTE} ` +
      'Templates and their params (all with `connection: { label, id?, updatePolicy? }`, optional pageName, navigation, oldPageNumber, notes): ' +
      'atem { inputs: count | [n | {input,label}], mixEffect?, programColor?, previewColor?, programTextColor?, previewTextColor?, transitions?, columns? }; ' +
      'videohub { inputs, outputs, routedColor?, routedTextColor?, labelColor?, ignoreLock? }; ' +
      'vmix { inputs: count | [number | name | {input,label}], mix? (1-16 or "Selected"), programColor?, previewColor?, tallyTextColor?, programRow?, columns? }; ' +
      'birddog { presets: count | [n | {input,label}] (1-64), buttonColor?, columns? }. Colors are RGB integers (0xff0000 = 16711680). ' +
      'Use the result with companion_import_page.',
    input: z.strictObject({
      template: z.enum(TEMPLATES),
      params: z
        .record(z.string(), z.unknown())
        .describe('Template parameters, see the tool description.'),
    }),
    annotations: readOnly('Generate a page from a template', false),
    run: async ({ template, params }) => {
      let file;
      try {
        file = generateTemplate(template, params);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return failure(
            {
              code: 'INVALID_PARAMS',
              message: `Invalid params for template "${template}".`,
              source: 'input',
            },
            {
              errors: error.issues.map((issue) => ({
                path: issue.path.join('.'),
                code: issue.code,
                message: issue.message,
              })),
            },
          );
        }
        return failure({
          code: 'INVALID_PARAMS',
          message: error instanceof Error ? error.message : 'Template failed',
          source: 'input',
        });
      }
      return exportResult(file, validateExport(file, { catalog: catalogLookup }));
    },
  });

  defineTool(server, {
    name: 'build_page',
    title: 'Build a page from a free specification',
    description:
      `Builds a page export from buttons, actions and feedbacks and validates it against the catalog. ${OFFLINE_NOTE} ` +
      'Rows and columns are 0-based. `connections` lists the connections the page needs (label + moduleId); actions and feedbacks reference them by label, or use "internal" for Companion\'s own actions. ' +
      'Use companion_catalog_action to look up action ids and option ids first. Use the result with companion_import_page.',
    input: BuildPageInput,
    annotations: readOnly('Build a page from a free specification', false),
    run: async (input) => {
      const labels = new Set<string>();
      const instances: Record<string, ExportInstance> = {};
      for (const connection of input.connections) {
        if (labels.has(connection.label)) {
          return failure({
            code: 'INVALID_INPUT',
            message: `Duplicate connection label "${connection.label}".`,
            source: 'input',
          });
        }
        labels.add(connection.label);
        instances[connection.label] = buildConnection({
          label: connection.label,
          moduleId: connection.moduleId,
          ...(connection.updatePolicy === undefined
            ? {}
            : { updatePolicy: connection.updatePolicy }),
        });
      }
      const refs = input.buttons.flatMap((button) => [
        ...button.actions.map((a) => a.connection),
        ...(button.actionsUp ?? []).map((a) => a.connection),
        ...button.feedbacks.map((f) => f.connection),
      ]);
      const unknown = [...new Set(refs.filter((ref) => ref !== 'internal' && !labels.has(ref)))];
      if (unknown.length > 0) {
        return failure({
          code: 'UNKNOWN_CONNECTION',
          message: `Actions or feedbacks reference connections that are not in "connections": ${unknown.join(', ')}.`,
          source: 'input',
        });
      }

      const controls: PlacedControl[] = input.buttons.map((button) => ({
        row: button.row,
        column: button.column,
        control: buildButton(
          compact({
            text: button.text,
            textExpression: button.textExpression,
            bgColor: button.colors?.background,
            textColor: button.colors?.text,
            fontSize: button.fontSize,
            notes: button.notes,
            actions: button.actions.map(toAction),
            actionsUp: button.actionsUp?.map(toAction),
            feedbacks: button.feedbacks.map(toFeedback),
          }),
        ),
      }));
      let file;
      try {
        file = buildPageExport(
          compact({
            name: input.pageName,
            controls,
            instances,
            gridSize: input.grid,
            navigation: input.navigation,
          }),
        );
      } catch (error) {
        return failure({
          code: 'INVALID_INPUT',
          message: error instanceof Error ? error.message : 'Page could not be built',
          source: 'input',
        });
      }
      return exportResult(file, validateExport(file, { catalog: catalogLookup }));
    },
  });
}
