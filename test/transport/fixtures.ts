import type { JsonObject } from '../../src/safety/json.js';

function prop(value: string | number | boolean): JsonObject {
  return { isExpression: false, value };
}

function layer(id: string, type: string, extra: JsonObject, pinned?: string[]): JsonObject {
  return {
    id,
    name: id,
    usage: 'auto',
    type,
    ...(pinned ? { pinnedProperties: pinned } : {}),
    ...extra,
  };
}

/** Anonymized minimal page export (version 12, one `button-layered` control at 0/0) in the measured 5.1.3 format. */
export function buildTestPage(
  options: { text?: string; pageName?: string; withPinned?: boolean } = {},
): JsonObject {
  const pinned = options.withPinned ?? true;
  return {
    version: 12,
    type: 'page',
    companionBuild: '5.1.3+fixture',
    page: {
      name: options.pageName ?? 'TESTPAGE',
      controls: {
        '0': {
          '0': {
            type: 'button-layered',
            style: {
              layers: [
                layer('canvas', 'canvas', {
                  decoration: prop('default'),
                  showStatusIcons: prop('default'),
                }),
                layer(
                  'box0',
                  'box',
                  { enabled: prop(true), opacity: prop(100), color: prop(65280), width: prop(100) },
                  pinned ? ['color'] : undefined,
                ),
                layer(
                  'text0',
                  'text',
                  { enabled: prop(true), text: prop(options.text ?? 'HELLO'), fontsize: prop(44) },
                  pinned ? ['text', 'fontsize'] : undefined,
                ),
              ],
            },
            options: { stepProgression: 'auto', stepExpression: '', rotaryActions: false },
            feedbacks: [
              {
                id: 'fb-intended-1',
                definitionId: 'variable_value',
                connectionId: 'internal',
                type: 'feedback',
                options: { variable: prop('custom:mytest'), op: prop('eq'), value: prop('42') },
                isInverted: prop(false),
                styleOverrides: [
                  {
                    overrideId: 'ov1',
                    elementId: 'box0',
                    elementProperty: 'color',
                    override: prop(16711680),
                  },
                ],
                children: {},
              },
            ],
            steps: {
              '0': {
                action_sets: {
                  down: [
                    {
                      id: 'ac-intended-1',
                      definitionId: 'custom_variable_set_value',
                      connectionId: 'internal',
                      type: 'action',
                      options: { name: prop('mytest'), create: prop(true), value: prop('42') },
                      children: {},
                    },
                  ],
                  up: [],
                },
                options: { runWhileHeld: [] },
              },
            },
            localVariables: [],
          },
        },
      },
      gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 },
    },
    instances: {},
    connectionCollections: [],
    oldPageNumber: 1,
    imageLibrary: [],
    imageLibraryCollections: [],
  };
}

/** Deep copy helper for tests that mutate a fixture. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
