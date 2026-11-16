/**
 * ATEM switcher page: program row, preview row, CUT and AUTO.
 *
 * Module `bmd-atem`. Action and feedback IDs and options are taken from the module source
 * (research note 05, `src/actions/mixeffect/programPreview.ts`, `src/feedback/mixeffect/programPreview.ts`):
 * actions `program`, `preview`, `cut`, `auto` with options `mixeffect` (1-based) and `input` (source ID);
 * boolean feedbacks `program` and `preview` with the same options.
 */
import {
  buildButton,
  buildPageExport,
  randomIdGenerator,
  type PlacedControl,
} from '../builders.js';
import type { PageExport } from '../schema.js';
import {
  assertPositiveInteger,
  availableColumns,
  instancesFor,
  normalizeInputs,
  startColumn,
  type LabeledInput,
  type TemplateBaseOptions,
} from './common.js';

export const ATEM_MODULE_ID = 'bmd-atem';

export interface AtemSwitcherPageOptions extends TemplateBaseOptions {
  /** Source IDs (as shown in the ATEM module, for example 1 to 8) with optional labels, or a count `N` for 1..N. */
  inputs: number | Array<number | LabeledInput>;
  /** M/E number, 1-based. Default 1. */
  mixEffect?: number;
  /** Background while the input is on program. Default red. */
  programColor?: number;
  /** Background while the input is on preview. Default green. */
  previewColor?: number;
  /** Text color on the program and preview buttons. Defaults: white on program, black on preview. */
  programTextColor?: number;
  previewTextColor?: number;
  /** Add CUT and AUTO buttons below the preview rows. Default `true`. */
  transitions?: boolean;
  /** Inputs per row. Default: all columns of the default grid after the navigation column. */
  columns?: number;
}

export function atemSwitcherPage(options: AtemSwitcherPageOptions): PageExport {
  const ids = options.ids ?? randomIdGenerator;
  const mixEffect = options.mixEffect ?? 1;
  assertPositiveInteger(mixEffect, 'mixEffect');
  const inputs = normalizeInputs(options.inputs, 'inputs');
  const columns = availableColumns(options, options.columns);
  const programColor = options.programColor ?? 0xff0000;
  const previewColor = options.previewColor ?? 0x00ff00;
  const first = startColumn(options);
  const connectionId = options.connection.id;
  const rowsPerBlock = Math.ceil(inputs.length / columns);

  const controls: PlacedControl[] = [];

  const block = (kind: 'program' | 'preview', firstRow: number): void => {
    const color = kind === 'program' ? programColor : previewColor;
    const textColor =
      kind === 'program'
        ? (options.programTextColor ?? 0xffffff)
        : (options.previewTextColor ?? 0x000000);
    inputs.forEach((entry, index) => {
      const inputOptions = { mixeffect: mixEffect, input: entry.input };
      controls.push({
        row: firstRow + Math.floor(index / columns),
        column: first + (index % columns),
        control: buildButton({
          text: entry.label ?? String(entry.input),
          notes: `${kind === 'program' ? 'Program' : 'Preview'} input ${entry.input}`,
          actions: [{ connectionId, definitionId: kind, options: inputOptions }],
          feedbacks: [
            {
              connectionId,
              definitionId: kind,
              options: inputOptions,
              style: { bgColor: color, textColor },
            },
          ],
          ids,
        }),
      });
    });
  };

  block('program', 0);
  block('preview', rowsPerBlock);

  if (options.transitions !== false) {
    const row = rowsPerBlock * 2;
    controls.push(
      {
        row,
        column: first,
        control: buildButton({
          text: 'CUT',
          bgColor: 0x600000,
          notes: 'Perform CUT transition',
          actions: [{ connectionId, definitionId: 'cut', options: { mixeffect: mixEffect } }],
          ids,
        }),
      },
      {
        row,
        column: first + 1,
        control: buildButton({
          text: 'AUTO',
          bgColor: 0x600000,
          notes: 'Perform AUTO transition',
          actions: [{ connectionId, definitionId: 'auto', options: { mixeffect: mixEffect } }],
          ids,
        }),
      },
    );
  }

  return buildPageExport({
    name: options.pageName ?? 'ATEM Switcher',
    controls,
    instances: instancesFor(ATEM_MODULE_ID, options.connection),
    ...(options.navigation !== undefined && { navigation: options.navigation }),
    ...(options.oldPageNumber !== undefined && { oldPageNumber: options.oldPageNumber }),
    ...(options.companionBuild !== undefined && { companionBuild: options.companionBuild }),
    ...(options.notes !== undefined && { notes: options.notes }),
  });
}
