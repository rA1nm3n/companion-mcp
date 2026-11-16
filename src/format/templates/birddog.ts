/**
 * BirdDog PTZ preset page: one button per preset that recalls it.
 *
 * Module `birddog-ptz`. From the module source (research note 05, `actions.js:885-922`, `models.js:908-919`):
 * action `recallPset` with option `val` (text input holding the preset number as a string, valid range 1 to 64,
 * firmware 4 and newer). The module has no feedback for recalled presets, so the buttons carry none. Saving
 * presets (`savePset`) is deliberately not generated: a mis-press would overwrite a stored position.
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

export const BIRDDOG_MODULE_ID = 'birddog-ptz';

export const BIRDDOG_MAX_RECALL_PRESET = 64;

export interface BirddogPresetPageOptions extends TemplateBaseOptions {
  /** Preset numbers (1 to 64) with optional labels, or a count `N` for presets 1..N. */
  presets: number | Array<number | LabeledInput>;
  buttonColor?: number;
  columns?: number;
}

export function birddogPresetPage(options: BirddogPresetPageOptions): PageExport {
  const ids = options.ids ?? randomIdGenerator;
  const presets = normalizeInputs(options.presets, 'presets');
  for (const preset of presets) {
    assertPositiveInteger(preset.input, 'preset number');
    if (preset.input > BIRDDOG_MAX_RECALL_PRESET) {
      throw new Error(
        `preset number ${preset.input} exceeds the recall range 1 to ${BIRDDOG_MAX_RECALL_PRESET}`,
      );
    }
  }
  const columns = availableColumns(options, options.columns);
  const first = startColumn(options);
  const connectionId = options.connection.id;

  const controls: PlacedControl[] = presets.map((preset, index) => ({
    row: Math.floor(index / columns),
    column: first + (index % columns),
    control: buildButton({
      text: preset.label ?? `PRESET ${preset.input}`,
      bgColor: options.buttonColor ?? 0x202020,
      notes: `Recall preset ${preset.input}`,
      actions: [
        {
          connectionId,
          definitionId: 'recallPset',
          options: { val: String(preset.input) },
        },
      ],
      ids,
    }),
  }));

  return buildPageExport({
    name: options.pageName ?? 'BirdDog Presets',
    controls,
    instances: instancesFor(BIRDDOG_MODULE_ID, options.connection),
    ...(options.navigation !== undefined && { navigation: options.navigation }),
    ...(options.oldPageNumber !== undefined && { oldPageNumber: options.oldPageNumber }),
    ...(options.companionBuild !== undefined && { companionBuild: options.companionBuild }),
    ...(options.notes !== undefined && { notes: options.notes }),
  });
}
