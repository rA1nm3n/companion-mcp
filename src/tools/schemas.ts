import { z } from 'zod';
import { UpdatePolicySchema } from '../format/index.js';

/** Any JSON object (export files, option maps). Deeper structure is checked by `validateExport`. */
export const JsonObjectSchema = z.record(z.string(), z.json());

export const ColorSchema = z.union([z.number().int().min(0), z.string().min(1)]);

export const PageNumberSchema = z.number().int().min(1);

/** Target of an import: page number (>= 1) or -1 to append a new page. */
export const TargetPageSchema = z
  .number()
  .int()
  .refine((n) => n === -1 || n >= 1, {
    message: 'target_page must be an integer >= 1, or -1 to append a new page',
  });

export const GridSchema = z.strictObject({
  minColumn: z.number().int(),
  maxColumn: z.number().int(),
  minRow: z.number().int(),
  maxRow: z.number().int(),
});

/** Connection reference of a template: `id` is the key inside the export file (default: the label). */
export const TemplateConnectionSchema = z.strictObject({
  id: z.string().min(1).optional(),
  label: z.string().min(1),
  updatePolicy: UpdatePolicySchema.optional(),
});

export const LabeledSchema = z.union([
  z.number().int(),
  z.strictObject({ input: z.number().int(), label: z.string().optional() }),
]);
export const CountOrListSchema = z.union([z.number().int().min(1), z.array(LabeledSchema).min(1)]);

export const TemplateCommon = {
  connection: TemplateConnectionSchema,
  pageName: z.string().min(1).optional(),
  navigation: z.boolean().optional(),
  oldPageNumber: z.number().int().min(1).optional(),
  notes: z.string().optional(),
};

export const ColorNumber = z.number().int().min(0).max(0xffffff);
