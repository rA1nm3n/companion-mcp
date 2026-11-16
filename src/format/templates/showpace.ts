/**
 * ShowPace stage timer page: live display, transport, rundown and tempo buttons.
 *
 * Module `showpace-timer` (own module of the maintainer, source `rA1nm3n/showpace`, `integrations/companion`,
 * commit 824fddf, module 0.2.1). Everything here is taken from that source:
 * - actions `timer_start`, `timer_pause`, `timer_reset` (no options), `rundown_prev`, `rundown_next` (no options),
 *   `tempo_up`, `tempo_down`, `tempo_reset` (no options) and `tempo_set` (`pct`, number 50 to 200)
 *   (`src/actions.ts:63-106`);
 * - boolean feedbacks `running` (`state`: `running` | `paused`), `phase` (`phase`: `normal` | `warning` |
 *   `critical` | `overtime`) and `tempo_changed` (`src/feedbacks.ts:141-186`);
 * - variables `remaining`, `segment_title`, `next_title`, `tempo_pct` (`src/variables.ts:5-34`), referenced as
 *   `$(<connection label>:<id>)`.
 * ShowPace has no stop action: the page offers START, PAUSE and RESET (reset the timer of the current segment).
 * The default colors are the module's own feedback colors (`src/feedbacks.ts:27-44`).
 */
import {
  buildButton,
  buildPageExport,
  randomIdGenerator,
  type ButtonInput,
  type PlacedControl,
} from '../builders.js';
import type { PageExport } from '../schema.js';
import { availableColumns, instancesFor, startColumn, type TemplateBaseOptions } from './common.js';

export const SHOWPACE_MODULE_ID = 'showpace-timer';

/** Range of the `pct` option of `tempo_set` (`src/actions.ts:96-101`). */
export const SHOWPACE_TEMPO_MIN = 50;
export const SHOWPACE_TEMPO_MAX = 200;

const GREEN = 0x00802b;
const YELLOW = 0xffcc00;
const RED = 0xcc0000;
const ORANGE = 0xe06600;
const WHITE = 0xffffff;
const BLACK = 0x000000;

export interface ShowpaceTimerPageOptions extends TemplateBaseOptions {
  /** Tempo percentages with a direct-set button (`tempo_set`, 50 to 200). Default `[110, 120, 135]`; `[]` for none. */
  tempoSteps?: number[];
  /** Add the display row (remaining time, segment, next segment, tempo). Default `true`. */
  display?: boolean;
  /** Buttons per row. Default: all columns of the default grid after the navigation column. */
  columns?: number;
}

export function showpaceTimerPage(options: ShowpaceTimerPageOptions): PageExport {
  const ids = options.ids ?? randomIdGenerator;
  const columns = availableColumns(options, options.columns);
  const tempoSteps = options.tempoSteps ?? [110, 120, 135];
  for (const pct of tempoSteps) {
    if (!Number.isFinite(pct) || pct < SHOWPACE_TEMPO_MIN || pct > SHOWPACE_TEMPO_MAX) {
      throw new Error(
        `tempoSteps must be between ${SHOWPACE_TEMPO_MIN} and ${SHOWPACE_TEMPO_MAX}, got ${String(pct)}`,
      );
    }
  }
  const first = startColumn(options);
  const connectionId = options.connection.id;
  const variable = (id: string): string => `$(${options.connection.label}:${id})`;

  const action = (definitionId: string, actionOptions?: Record<string, number>) => ({
    connectionId,
    definitionId,
    ...(actionOptions !== undefined && { options: actionOptions }),
  });
  const phase = (
    value: 'normal' | 'warning' | 'critical' | 'overtime',
    bg: number,
    text: number,
  ) => ({
    connectionId,
    definitionId: 'phase',
    options: { phase: value },
    style: { bgColor: bg, textColor: text },
  });

  const blocks: ButtonInput[][] = [];

  if (options.display !== false) {
    blocks.push([
      {
        textExpression: `\`${variable('remaining')}\``,
        fontSize: 24,
        notes: 'Remaining time of the current segment, colored by phase',
        feedbacks: [
          phase('normal', GREEN, WHITE),
          phase('warning', YELLOW, BLACK),
          phase('critical', RED, WHITE),
          phase('overtime', RED, WHITE),
        ],
      },
      {
        textExpression: `\`${variable('segment_title')}\``,
        fontSize: 14,
        notes: 'Title of the current segment',
      },
      {
        textExpression: `\`NEXT: ${variable('next_title')}\``,
        fontSize: 14,
        notes: 'Title of the next segment',
      },
      {
        textExpression: `\`TEMPO ${variable('tempo_pct')} %\``,
        fontSize: 14,
        notes: 'Tempo factor in percent (visible in the control room only)',
        feedbacks: [
          {
            connectionId,
            definitionId: 'tempo_changed',
            style: { bgColor: ORANGE, textColor: WHITE },
          },
        ],
      },
    ]);
  }

  blocks.push([
    {
      text: 'START',
      notes: 'Start or resume the timer',
      actions: [action('timer_start')],
      feedbacks: [
        {
          connectionId,
          definitionId: 'running',
          options: { state: 'running' },
          style: { bgColor: GREEN, textColor: WHITE },
        },
      ],
    },
    {
      text: 'PAUSE',
      notes: 'Pause the timer',
      actions: [action('timer_pause')],
      feedbacks: [
        {
          connectionId,
          definitionId: 'running',
          options: { state: 'paused' },
          style: { bgColor: ORANGE, textColor: WHITE },
        },
      ],
    },
    {
      text: 'RESET',
      bgColor: 0x600000,
      notes: 'Reset the timer of the current segment',
      actions: [action('timer_reset')],
    },
  ]);

  blocks.push([
    {
      text: 'PREV',
      notes: 'Go to the previous segment',
      actions: [action('rundown_prev')],
    },
    {
      text: 'NEXT',
      notes: 'Go to the next segment',
      actions: [action('rundown_next')],
    },
  ]);

  blocks.push([
    { text: 'TEMPO -1 %', notes: 'Decrease the tempo by 1 %', actions: [action('tempo_down')] },
    { text: 'TEMPO +1 %', notes: 'Increase the tempo by 1 %', actions: [action('tempo_up')] },
    { text: 'TEMPO 100 %', notes: 'Reset the tempo to 100 %', actions: [action('tempo_reset')] },
  ]);

  if (tempoSteps.length > 0) {
    blocks.push(
      tempoSteps.map((pct) => ({
        text: `TEMPO ${pct} %`,
        notes: `Set the tempo to ${pct} %`,
        actions: [action('tempo_set', { pct })],
      })),
    );
  }

  const controls: PlacedControl[] = [];
  let row = 0;
  for (const block of blocks) {
    block.forEach((button, index) => {
      controls.push({
        row: row + Math.floor(index / columns),
        column: first + (index % columns),
        control: buildButton({ ...button, ids }),
      });
    });
    row += Math.ceil(block.length / columns);
  }

  return buildPageExport({
    name: options.pageName ?? 'ShowPace Timer',
    controls,
    instances: instancesFor(SHOWPACE_MODULE_ID, options.connection),
    ...(options.navigation !== undefined && { navigation: options.navigation }),
    ...(options.oldPageNumber !== undefined && { oldPageNumber: options.oldPageNumber }),
    ...(options.companionBuild !== undefined && { companionBuild: options.companionBuild }),
    ...(options.notes !== undefined && { notes: options.notes }),
  });
}
