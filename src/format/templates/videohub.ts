/**
 * Videohub routing matrix: one row per output, one column per input.
 *
 * Module `bmd-videohub`. From the module source (research note 05, `src/actions.ts:207-237`,
 * `src/feedback.ts:73-99`): action `route` with `source`, `destination` (both 1-based) and `ignore_lock`;
 * boolean feedback `input_bg` ("destination has specific source routed") with `input` and `output`.
 *
 * Layout: the first column of every row shows the output label, the input buttons follow. The grid grows to fit,
 * and importing a page larger than 8x4 enlarges the global grid of the Companion installation.
 */
import {
  buildButton,
  buildPageExport,
  randomIdGenerator,
  type PlacedControl,
} from '../builders.js';
import type { PageExport } from '../schema.js';
import {
  instancesFor,
  normalizeInputs,
  startColumn,
  type LabeledInput,
  type TemplateBaseOptions,
} from './common.js';

export const VIDEOHUB_MODULE_ID = 'bmd-videohub';

export interface VideohubRoutingPageOptions extends TemplateBaseOptions {
  /** Input numbers (1-based) with optional labels, or a count `N` for 1..N. */
  inputs: number | Array<number | LabeledInput>;
  /** Output numbers (1-based) with optional labels, or a count `N` for 1..N. */
  outputs: number | Array<number | LabeledInput>;
  /** Background of the input button that is currently routed to the row's output. Default green. */
  routedColor?: number;
  routedTextColor?: number;
  /** Background of the output label buttons. */
  labelColor?: number;
  /** Passed as `ignore_lock` to the route action. Default `false`. */
  ignoreLock?: boolean;
}

export function videohubRoutingPage(options: VideohubRoutingPageOptions): PageExport {
  const ids = options.ids ?? randomIdGenerator;
  const inputs = normalizeInputs(options.inputs, 'inputs');
  const outputs = normalizeInputs(options.outputs, 'outputs');
  const first = startColumn(options);
  const connectionId = options.connection.id;
  const routedColor = options.routedColor ?? 0x00ff00;
  const routedTextColor = options.routedTextColor ?? 0x000000;

  const controls: PlacedControl[] = [];

  outputs.forEach((output, row) => {
    controls.push({
      row,
      column: first,
      control: buildButton({
        text: output.label ?? `OUT ${output.input}`,
        bgColor: options.labelColor ?? 0x000060,
        notes: `Destination ${output.input}`,
        ids,
      }),
    });

    inputs.forEach((input, index) => {
      controls.push({
        row,
        column: first + 1 + index,
        control: buildButton({
          text: input.label ?? String(input.input),
          notes: `Route input ${input.input} to output ${output.input}`,
          actions: [
            {
              connectionId,
              definitionId: 'route',
              options: {
                source: input.input,
                destination: output.input,
                ignore_lock: options.ignoreLock ?? false,
              },
            },
          ],
          feedbacks: [
            {
              connectionId,
              definitionId: 'input_bg',
              options: { input: input.input, output: output.input },
              style: { bgColor: routedColor, textColor: routedTextColor },
            },
          ],
          ids,
        }),
      });
    });
  });

  return buildPageExport({
    name: options.pageName ?? 'Videohub Routing',
    controls,
    instances: instancesFor(VIDEOHUB_MODULE_ID, options.connection),
    ...(options.navigation !== undefined && { navigation: options.navigation }),
    ...(options.oldPageNumber !== undefined && { oldPageNumber: options.oldPageNumber }),
    ...(options.companionBuild !== undefined && { companionBuild: options.companionBuild }),
    ...(options.notes !== undefined && { notes: options.notes }),
  });
}
