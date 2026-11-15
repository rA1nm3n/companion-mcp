/**
 * vMix input page: a preview row and a program (cut) row with tally colors.
 *
 * Module `studiocoast-vmix`. From the module source (research note 05; `src/actions/inputActions.ts` `previewInput`,
 * `src/actions/transitionActions.ts` `programCut`, `src/feedbacks/tallyFeedbacks.ts` `inputPreview` / `inputLive`):
 * the actions take `input` (text: number, name or GUID) and `mix` (1 to 16 or `'Selected'`). The two tally feedbacks
 * are `advanced`: the module returns `{ color, bgcolor }` built from its options `fg` and `bg`, so the style overrides
 * name those result properties (`'bgcolor'`, `'color'`).
 */
import {
  buildButton,
  buildPageExport,
  randomIdGenerator,
  type PlacedControl,
} from '../builders.js';
import type { PageExport } from '../schema.js';
import {
  availableColumns,
  instancesFor,
  normalizeInputs,
  startColumn,
  type LabeledInput,
  type TemplateBaseOptions,
} from './common.js';

export const VMIX_MODULE_ID = 'studiocoast-vmix';

export interface VmixInputPageOptions extends TemplateBaseOptions {
  /** vMix inputs (number, name or GUID) with optional labels, or a count `N` for inputs 1..N. */
  inputs: number | Array<number | string | LabeledInput<number | string>>;
  /** Mix number 1 to 16 or `'Selected'`. Default 1. */
  mix?: number | 'Selected';
  /** Tally background for program and preview. Defaults red and green, the module's own defaults. */
  programColor?: number;
  previewColor?: number;
  /** Tally text color. Default black like the module. */
  tallyTextColor?: number;
  /** Add a second block that cuts the input directly to program. Default `true`. */
  programRow?: boolean;
  columns?: number;
}

export function vmixInputPage(options: VmixInputPageOptions): PageExport {
  const ids = options.ids ?? randomIdGenerator;
  const inputs = normalizeInputs<number | string>(options.inputs, 'inputs');
  const columns = availableColumns(options, options.columns);
  const mix = options.mix ?? 1;
  const programColor = options.programColor ?? 0xff0000;
  const previewColor = options.previewColor ?? 0x00ff00;
  const tallyTextColor = options.tallyTextColor ?? 0x000000;
  const first = startColumn(options);
  const connectionId = options.connection.id;
  const rowsPerBlock = Math.ceil(inputs.length / columns);

  const controls: PlacedControl[] = [];

  const block = (kind: 'preview' | 'program', firstRow: number): void => {
    inputs.forEach((entry, index) => {
      const input = String(entry.input);
      controls.push({
        row: firstRow + Math.floor(index / columns),
        column: first + (index % columns),
        control: buildButton({
          text: entry.label ?? input,
          notes: kind === 'preview' ? `Preview input ${input}` : `Cut input ${input} to program`,
          actions: [
            {
              connectionId,
              definitionId: kind === 'preview' ? 'previewInput' : 'programCut',
              options: { input, mix },
            },
          ],
          feedbacks: [
            {
              connectionId,
              definitionId: kind === 'preview' ? 'inputPreview' : 'inputLive',
              options: {
                input,
                mix,
                fg: tallyTextColor,
                bg: kind === 'preview' ? previewColor : programColor,
                tally: '',
              },
              style: { bgFromResult: 'bgcolor', textFromResult: 'color' },
            },
          ],
          ids,
        }),
      });
    });
  };

  block('preview', 0);
  if (options.programRow !== false) block('program', rowsPerBlock);

  return buildPageExport({
    name: options.pageName ?? 'vMix Inputs',
    controls,
    instances: instancesFor(VMIX_MODULE_ID, options.connection),
    ...(options.navigation !== undefined && { navigation: options.navigation }),
    ...(options.oldPageNumber !== undefined && { oldPageNumber: options.oldPageNumber }),
    ...(options.companionBuild !== undefined && { companionBuild: options.companionBuild }),
    ...(options.notes !== undefined && { notes: options.notes }),
  });
}
