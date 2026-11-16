import { z } from 'zod';

/**
 * Catalog schemas.
 *
 * The catalog is OFFLINE data about Companion modules (actions, feedbacks, option schemas). It is
 * extracted by reading module source code and is not tested against devices. See docs/catalog.md.
 */

/** How well an entry is backed by evidence. See docs/catalog.md. */
export const VerificationStatusSchema = z.enum(['verified-sample', 'read', 'unverified']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/** Whether the module's action/feedback list is the complete list found in the source. */
export const CoverageSchema = z.enum(['complete', 'partial']);
export type Coverage = z.infer<typeof CoverageSchema>;

export const OptionTypeSchema = z.enum([
  'dropdown',
  'number',
  'textinput',
  'checkbox',
  'colorpicker',
  'multidropdown',
  'other',
]);
export type OptionType = z.infer<typeof OptionTypeSchema>;

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/** JSON value used for option defaults. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const ChoiceSchema = z
  .object({
    id: ScalarSchema,
    label: z.string().optional(),
  })
  .strict();
export type Choice = z.infer<typeof ChoiceSchema>;

/**
 * One option (input field) of an action or feedback.
 *
 * Choice semantics:
 * - `choices` is a CLOSED list: the module defines exactly these ids.
 * - `choicesNote` describes lists that depend on the device or the model (not enumerable offline).
 * - Dropdown ids keep their source type: `1` and `'1'` are different values.
 */
export const OptionDefSchema = z
  .object({
    id: z.string().min(1),
    type: OptionTypeSchema,
    label: z.string().optional(),
    description: z.string().optional(),
    default: JsonValueSchema.optional(),
    choices: z.array(ChoiceSchema).optional(),
    choicesNote: z.string().optional(),
    /** Expected JS type of dropdown ids when the list is dynamic. `numeric` = number or numeric string. */
    valueType: z.enum(['number', 'string', 'numeric']).optional(),
    /** Regular expression (JS source, no slashes) that string ids of a dynamic dropdown must match. */
    valuePattern: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    /** `asInteger` in the module source: only whole numbers. */
    integer: z.boolean().optional(),
    useVariables: z.boolean().optional(),
    required: z.boolean().optional(),
    allowCustom: z.boolean().optional(),
    allowInvalidValues: z.boolean().optional(),
    /** The field cannot be switched to expression mode (module sets `disableAutoExpression`). */
    disableAutoExpression: z.boolean().optional(),
    /** Textinput `regex` from the module source, as written there (e.g. `/^\\d+$/`). Informational. */
    regex: z.string().optional(),
    /** Source `isVisible`/`isVisibleExpression`/`isVisibleUi` text, informational. */
    visibleWhen: z.string().optional(),
    /** Original Companion field type when `type` is `other` (e.g. `internal:page`, `expression`). */
    rawType: z.string().optional(),
  })
  .strict();
export type OptionDef = z.infer<typeof OptionDefSchema>;

export const ProvenanceSchema = z
  .object({
    /** Path relative to the module repository root. */
    file: z.string().min(1),
    /** 1-based line where the definition starts. */
    line: z.number().int().positive(),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

const EntityBaseShape = {
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  options: z.array(OptionDefSchema),
  /**
   * `false` when the option list was not read completely: unknown options are then NOT reported
   * by the validator. Defaults to `true`.
   */
  optionsComplete: z.boolean().optional(),
  /** Per-entity override of the module-level expression support (used by the `internal` module). */
  optionsSupportExpressions: z.boolean().optional(),
  /** Free text, e.g. "only registered for models with serial ports". */
  availability: z.string().optional(),
  provenance: ProvenanceSchema,
};

export const ActionDefSchema = z.object(EntityBaseShape).strict();
export type ActionDef = z.infer<typeof ActionDefSchema>;

export const FeedbackDefSchema = z
  .object({
    ...EntityBaseShape,
    feedbackType: z.enum(['boolean', 'advanced', 'value']).optional(),
  })
  .strict();
export type FeedbackDef = z.infer<typeof FeedbackDefSchema>;

export const ModuleDefSchema = z
  .object({
    /** Manifest id, as used in `instance_types`/`moduleId` of a Companion connection. */
    moduleId: z.string().min(1),
    name: z.string().min(1),
    /** `owner/name` on GitHub. */
    repo: z.string().min(1),
    /** Module version from package.json at the inspected commit. */
    version: z.string().min(1),
    /** `@companion-module/base` version range from package.json (decides expression support). */
    baseVersion: z.string().min(1),
    /** Date of the inspected commit (YYYY-MM-DD). */
    lastCommit: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Short hash of the inspected commit, when known. */
    lastCommitSha: z.string().optional(),
    status: VerificationStatusSchema,
    coverage: CoverageSchema,
    /**
     * Explicit expression support. When absent it is derived from `baseVersion`: modules built on
     * `@companion-module/base` 2.x support expressions, 1.x modules do not.
     */
    optionsSupportExpressions: z.boolean().optional(),
    actions: z.array(ActionDefSchema),
    feedbacks: z.array(FeedbackDefSchema),
    notes: z.array(z.string()).optional(),
  })
  .strict();
export type ModuleDef = z.infer<typeof ModuleDefSchema>;

export const IndexKindSchema = z.enum(['full', 'index-only']);
export type IndexKind = z.infer<typeof IndexKindSchema>;

export const IndexEntrySchema = z
  .object({
    moduleId: z.string().min(1),
    repo: z.string().min(1),
    version: z.string().min(1),
    baseVersion: z.string().min(1),
    lastCommit: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: IndexKindSchema,
    manufacturer: z.string().optional(),
    products: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .strict();
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

/** A device or software without a Companion module, with generic alternatives. */
export const NoModuleEntrySchema = z
  .object({
    device: z.string().min(1),
    result: z.string().min(1),
    /** Module ids of generic modules that can be used instead. */
    alternatives: z.array(z.string().min(1)),
    note: z.string().optional(),
  })
  .strict();
export type NoModuleEntry = z.infer<typeof NoModuleEntrySchema>;

/** A repository that exists but cannot be used as a connection module. */
export const UnusableEntrySchema = z
  .object({
    repo: z.string().min(1),
    directory: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type UnusableEntry = z.infer<typeof UnusableEntrySchema>;

export const IndexFileSchema = z
  .object({
    /** Date the index was generated from the repository clones (YYYY-MM-DD). */
    generated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    modules: z.array(IndexEntrySchema),
    noModule: z.array(NoModuleEntrySchema),
    unusable: z.array(UnusableEntrySchema),
  })
  .strict();
export type IndexFile = z.infer<typeof IndexFileSchema>;

/** Validation finding. `path` is a dotted path such as `options.source`. */
export interface Issue {
  path: string;
  code: IssueCode;
  message: string;
}

export type IssueCode =
  | 'unknown-module'
  | 'unknown-action'
  | 'unknown-feedback'
  | 'unknown-option'
  | 'missing-option'
  | 'invalid-option-shape'
  | 'invalid-type'
  | 'invalid-value'
  | 'out-of-range'
  | 'pattern-mismatch'
  | 'expression-not-supported'
  | 'expression-not-allowed';

/** One option value in the Companion 5 entity format. */
export interface OptionValue {
  isExpression: boolean;
  value: unknown;
}
export type OptionValues = Record<string, OptionValue>;
