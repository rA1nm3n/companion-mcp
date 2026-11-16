import { describe, expect, it } from 'vitest';
import {
  atemSwitcherPage,
  buildButton,
  buildConnection,
  buildPageExport,
  buildTriggerExport,
  createSequentialIdGenerator,
  validateExport,
  type CatalogLookup,
} from '../../src/format/index.js';
import { clone, loadFixture } from './helpers/fixtures.js';
import { testCatalog } from './helpers/test-catalog.js';

function codes(json: unknown, options?: { catalog?: CatalogLookup }): string[] {
  return validateExport(json, options).errors.map((e) => e.code);
}

function warningCodes(json: unknown): string[] {
  return validateExport(json).warnings.map((w) => w.code);
}

const golden = () => loadFixture('testA-seite-v12');
const firstButton = (file: any) => file.page.controls['0']['0'];

describe('measured pitfalls', () => {
  it.each([
    ['testB-seite-v17', 17],
    ['testB2-seite-v18', 18],
    ['testB3-seite-v5', 5],
  ])('%s: version %i is an error (Companion 5.1.3 accepts it silently)', (name) => {
    const result = validateExport(loadFixture(name));
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(['unsupported-version']);
    expect(result.errors[0]?.path).toBe('/version');
  });

  it('missing version is an error', () => {
    const file = golden();
    delete file.version;
    expect(codes(file)).toEqual(['missing-version']);
  });

  it('legacy "button" control at version 12 is an error (testB4)', () => {
    const result = validateExport(loadFixture('testB4-legacy-button-v12'));
    expect(result.errors.map((e) => e.code)).toEqual(['legacy-button-dropped-silently']);
    expect(result.errors[0]?.path).toBe('/page/controls/0/0/type');
  });

  it('legacy "button" at version 17 is reported together with the version (testB5, import silently drops it)', () => {
    const result = validateExport(loadFixture('testB5-legacy-button-v17'));
    expect(result.errors.map((e) => e.code).sort()).toEqual([
      'legacy-button-dropped-silently',
      'unsupported-version',
    ]);
  });

  it('connection without updatePolicy is an error (REST v2 500)', () => {
    const file = golden();
    file.instances = { c1: { label: 'atem', moduleId: 'bmd-atem', lastUpgradeIndex: -1 } };
    const result = validateExport(file);
    expect(result.errors.map((e) => e.code)).toEqual(['connection-missing-update-policy']);
    expect(result.errors[0]?.path).toBe('/instances/c1/updatePolicy');
  });

  it('connection with an invalid updatePolicy is an error', () => {
    const file = golden();
    file.instances = {
      c1: { label: 'atem', moduleId: 'bmd-atem', lastUpgradeIndex: -1, updatePolicy: 'auto' },
    };
    expect(codes(file)).toEqual(['connection-invalid-update-policy']);
  });

  it('a connection without lastUpgradeIndex only warns (Companion fills in -1)', () => {
    const file = golden();
    file.instances = { c1: { label: 'atem', moduleId: 'bmd-atem', updatePolicy: 'manual' } };
    const result = validateExport(file);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('connection-missing-last-upgrade-index');
  });

  it('entity referencing an undeclared connection is an error (dropped silently on import)', () => {
    const file = golden();
    firstButton(file).steps['0'].action_sets.down[0].connectionId = 'ghost';
    const result = validateExport(file);
    expect(result.errors.map((e) => e.code)).toEqual(['entity-unknown-connection']);
    expect(result.errors[0]?.path).toBe(
      '/page/controls/0/0/steps/0/action_sets/down/0/connectionId',
    );
  });

  it('a connection without label is skipped on import, so its entities count as unknown', () => {
    const file = golden();
    file.instances = { c1: { moduleId: 'bmd-atem', lastUpgradeIndex: -1, updatePolicy: 'manual' } };
    firstButton(file).steps['0'].action_sets.down[0].connectionId = 'c1';
    expect(codes(file).sort()).toEqual(['connection-missing-label', 'entity-unknown-connection']);
  });
});

describe('coordinates and grid', () => {
  it.each([
    ['row below the grid', '9', '0'],
    ['column right of the grid', '0', '8'],
    ['negative row', '-1', '0'],
  ])('%s is an error', (_label, row, column) => {
    const file = golden();
    file.page.controls[row] = { ...(file.page.controls[row] ?? {}), [column]: { type: 'pagenum' } };
    expect(codes(file)).toContain('coordinates-out-of-grid');
  });

  it('respects a larger declared grid', () => {
    const file = golden();
    file.page.gridSize = { minColumn: 0, maxColumn: 15, minRow: 0, maxRow: 7 };
    file.page.controls['7'] = { '15': { type: 'pagenum' } };
    const result = validateExport(file);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain('grid-exceeds-default');
  });

  it('keys that normalise to the same position are duplicates', () => {
    const file = golden();
    file.page.controls['0']['00'] = { type: 'pagenum' };
    expect(codes(file)).toEqual(['duplicate-position']);
  });

  it('non-integer coordinate keys are errors', () => {
    const file = golden();
    file.page.controls['0']['a'] = { type: 'pagenum' };
    file.page.controls['x'] = { '0': { type: 'pagenum' } };
    expect(codes(file)).toEqual(['invalid-coordinate', 'invalid-coordinate']);
  });

  it('an inverted grid is an error', () => {
    const file = golden();
    file.page.gridSize = { minColumn: 5, maxColumn: 2, minRow: 0, maxRow: 3 };
    expect(codes(file)).toContain('invalid-grid');
  });
});

describe('required fields and types', () => {
  it('missing page name', () => {
    const file = golden();
    delete file.page.name;
    const result = validateExport(file);
    expect(result.errors).toEqual([
      expect.objectContaining({ path: '/page/name', code: 'missing-required-field' }),
    ]);
  });

  it('missing steps and feedbacks on a button', () => {
    const file = golden();
    delete firstButton(file).steps;
    delete firstButton(file).feedbacks;
    const result = validateExport(file);
    expect(result.errors.map((e) => [e.path, e.code])).toEqual(
      expect.arrayContaining([
        ['/page/controls/0/0/steps', 'missing-required-field'],
        ['/page/controls/0/0/feedbacks', 'missing-required-field'],
      ]),
    );
  });

  it('wrong type is reported with its path', () => {
    const file = golden();
    firstButton(file).options.rotaryActions = 'no';
    const result = validateExport(file);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: '/page/controls/0/0/options/rotaryActions',
        code: 'invalid-type',
      }),
    ]);
  });

  it('missing gridSize', () => {
    const file = golden();
    delete file.page.gridSize;
    expect(validateExport(file).errors).toEqual([
      expect.objectContaining({ path: '/page/gridSize', code: 'missing-required-field' }),
    ]);
  });

  it('unknown control type', () => {
    const file = golden();
    file.page.controls['1'] = { '1': { type: 'hologram' } };
    expect(codes(file)).toEqual(['unknown-control-type']);
  });

  it('control without type', () => {
    const file = golden();
    file.page.controls['1'] = { '1': {} };
    expect(codes(file)).toEqual(['missing-required-field']);
  });

  it('invalid layer: missing property on the text layer', () => {
    const file = golden();
    delete firstButton(file).style.layers[2].fontsize;
    expect(validateExport(file).errors).toEqual([
      expect.objectContaining({
        path: '/page/controls/0/0/style/layers/2/fontsize',
        code: 'missing-required-field',
      }),
    ]);
  });
});

describe('option wrappers', () => {
  it('raw option value is an error', () => {
    const file = golden();
    firstButton(file).steps['0'].action_sets.down[0].options.value = '42';
    const result = validateExport(file);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: '/page/controls/0/0/steps/0/action_sets/down/0/options/value',
        code: 'invalid-option-wrapper',
      }),
    ]);
  });

  it('wrapper without isExpression, with non-boolean isExpression, or with expression value that is no string', () => {
    const file = golden();
    const options = firstButton(file).steps['0'].action_sets.down[0].options;
    options.a = { value: 1 };
    options.b = { isExpression: 'false', value: 1 };
    options.c = { isExpression: true, value: 5 };
    const result = validateExport(file);
    expect(result.errors.map((e) => e.path).sort()).toEqual(
      ['a', 'b', 'c'].map((k) => `/page/controls/0/0/steps/0/action_sets/down/0/options/${k}`),
    );
    expect(new Set(result.errors.map((e) => e.code))).toEqual(new Set(['invalid-option-wrapper']));
  });

  it('raw isInverted is an error', () => {
    const file = golden();
    firstButton(file).feedbacks[0].isInverted = false;
    expect(codes(file)).toEqual(['invalid-option-wrapper']);
  });

  it('nested children are checked recursively', () => {
    const file = golden();
    const action = firstButton(file).steps['0'].action_sets.down[0];
    action.children = {
      actions: [
        {
          type: 'action',
          id: 'child1',
          definitionId: 'wait',
          connectionId: 'internal',
          options: { time: 500 },
          children: {},
        },
      ],
    };
    const result = validateExport(file);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: '/page/controls/0/0/steps/0/action_sets/down/0/children/actions/0/options/time',
        code: 'invalid-option-wrapper',
      }),
    ]);
  });

  it('an option value that is simply missing is accepted (real Companion exports contain these)', () => {
    const file = loadFixture('referenz-button-config');
    const page = buildPageExport({ name: 'REF', controls: [{ row: 0, column: 0, control: file }] });
    expect(validateExport(page).ok).toBe(true);
  });
});

describe('layers and style overrides', () => {
  it('style override pointing at a missing layer', () => {
    const file = golden();
    firstButton(file).feedbacks[0].styleOverrides[0].elementId = 'nope';
    const result = validateExport(file);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: '/page/controls/0/0/feedbacks/0/styleOverrides/0/elementId',
        code: 'override-unknown-element',
      }),
    ]);
  });

  it('duplicate layer ids', () => {
    const file = golden();
    firstButton(file).style.layers[2].id = 'box0';
    expect(codes(file)).toEqual(['duplicate-element-id']);
  });

  it('canvas layer must be first', () => {
    const file = golden();
    const layers = firstButton(file).style.layers;
    layers.reverse();
    expect(codes(file)).toContain('canvas-not-first');
  });

  it('group children are validated and their ids count for overrides', () => {
    const file = golden();
    const button = firstButton(file);
    const group = {
      ...clone(button.style.layers[1]),
      type: 'group',
      id: 'grp',
      squareCoords: { isExpression: false, value: false },
      children: [{ ...clone(button.style.layers[1]), id: 'inner' }],
    };
    delete group.color;
    button.style.layers.push(group);
    button.feedbacks[0].styleOverrides[0].elementId = 'inner';
    expect(validateExport(file).errors).toEqual([]);

    delete group.children[0].color;
    expect(validateExport(file).errors).toEqual([
      expect.objectContaining({
        path: '/page/controls/0/0/style/layers/3/children/0/color',
        code: 'missing-required-field',
      }),
    ]);
  });

  it('unknown keys on controls, layers and entities are warnings', () => {
    const file = golden();
    const button = firstButton(file);
    button.feedback = [];
    button.style.layers[1].colour = 1;
    button.steps['0'].action_sets.down[0].delay = 100;
    const result = validateExport(file);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.path).sort()).toEqual([
      '/page/controls/0/0/feedback',
      '/page/controls/0/0/steps/0/action_sets/down/0/delay',
      '/page/controls/0/0/style/layers/1/colour',
    ]);
  });
});

describe('steps and action sets', () => {
  it('invalid action set id is an error (skipped on import)', () => {
    const file = golden();
    firstButton(file).steps['0'].action_sets.sideways = [];
    expect(codes(file)).toEqual(['invalid-action-set-id']);
  });

  it('numeric hold-duration set is valid', () => {
    const file = golden();
    firstButton(file).steps['0'].action_sets['1000'] = [];
    expect(validateExport(file).errors).toEqual([]);
  });

  it('rotate sets without rotaryActions warn', () => {
    const file = golden();
    firstButton(file).steps['0'].action_sets.rotate_left = [];
    const result = validateExport(file);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(['rotary-without-rotary-actions']);
  });

  it('entity of the wrong kind in a list warns', () => {
    const file = golden();
    const button = firstButton(file);
    button.feedbacks.push(clone(button.steps['0'].action_sets.down[0]));
    button.feedbacks.at(-1).id = 'other';
    expect(warningCodes(file)).toContain('entity-type-mismatch');
  });

  it('duplicate entity ids warn', () => {
    const file = golden();
    const button = firstButton(file);
    button.steps['0'].action_sets.up.push(clone(button.steps['0'].action_sets.down[0]));
    expect(warningCodes(file)).toContain('duplicate-entity-id');
  });
});

describe('top level', () => {
  it('invalid JSON text', () => {
    expect(codes('{nope')).toEqual(['invalid-json']);
  });

  it('valid JSON text is parsed', () => {
    expect(validateExport(JSON.stringify(golden())).ok).toBe(true);
  });

  it.each([[null], [42], [[]], ['"x"']])('non-object %j', (value) => {
    expect(validateExport(value).ok).toBe(false);
  });

  it('unknown export type', () => {
    expect(codes({ version: 12, type: 'zip' })).toEqual(['unknown-export-type']);
  });

  it('full export: page numbers must be positive integers', () => {
    const page = golden().page;
    const full = {
      version: 12,
      type: 'full',
      pages: { '1': page, '0': clone(page), x: clone(page) },
      instances: {},
    };
    expect(codes(full)).toEqual(['invalid-page-number', 'invalid-page-number']);
  });
});

describe('triggers', () => {
  const connection = buildConnection({ moduleId: 'bmd-atem', label: 'atem' });
  const build = () =>
    buildTriggerExport({
      ids: createSequentialIdGenerator(),
      instances: { atem1: connection },
      collections: [
        { id: 'col1', label: 'Show', sortOrder: 0, children: [], metaData: { enabled: true } },
      ],
      triggers: [
        {
          id: 'trig1',
          name: 'On startup',
          collectionId: 'col1',
          events: [{ type: 'startup', options: { delay: 10000 } }],
          condition: [
            {
              connectionId: 'internal',
              definitionId: 'check_expression',
              options: { expression: { isExpression: true, value: '$(custom:mode) == 1' } },
            },
          ],
          actions: [
            {
              connectionId: 'atem1',
              definitionId: 'cut',
              options: { mixeffect: 1 },
            },
          ],
        },
      ],
    });

  it('a built trigger export is valid, also against the catalog', () => {
    expect(validateExport(build()).errors).toEqual([]);
    expect(validateExport(build(), { catalog: testCatalog }).errors).toEqual([]);
  });

  it('unknown collection warns', () => {
    const file = build();
    file.triggers.trig1!.options.collectionId = 'gone';
    expect(warningCodes(file)).toEqual(['unknown-collection']);
  });

  it('wrapped event options warn (events use raw values)', () => {
    const file = build();
    file.triggers.trig1!.events[0]!.options.delay = { isExpression: false, value: 10000 };
    expect(warningCodes(file)).toEqual(['wrapped-event-option']);
  });

  it('raw trigger action options are errors', () => {
    const file: any = build();
    file.triggers.trig1.actions[0].options.mixeffect = 1;
    expect(codes(file)).toEqual(['invalid-option-wrapper']);
  });

  it('a full export with pages and triggers validates both parts', () => {
    const page = atemSwitcherPage({
      connection: { id: 'atem1', label: 'atem' },
      inputs: 2,
      ids: createSequentialIdGenerator(),
    });
    const triggers = build();
    const full = {
      version: 12,
      type: 'full',
      pages: { '1': page.page },
      instances: page.instances,
      triggers: triggers.triggers,
      triggerCollections: triggers.triggerCollections,
    };
    expect(validateExport(full).errors).toEqual([]);

    full.pages['1']!.controls['0']!['0'] = { type: 'button' } as never;
    full.triggers.trig1!.options.name = 5 as never;
    expect(codes(full).sort()).toEqual(['invalid-type', 'legacy-button-dropped-silently']);
  });
});

describe('catalog', () => {
  const page = () =>
    atemSwitcherPage({
      connection: { id: 'atem1', label: 'atem' },
      inputs: 2,
      ids: createSequentialIdGenerator(),
    });

  it('accepts known modules, actions, feedbacks and options', () => {
    expect(validateExport(page(), { catalog: testCatalog }).errors).toEqual([]);
  });

  it('works without a catalog even for unknown modules', () => {
    const file = page();
    file.instances.atem1!.moduleId = 'some-module';
    expect(validateExport(file).errors).toEqual([]);
  });

  it('unknown module', () => {
    const file = page();
    file.instances.atem1!.moduleId = 'some-module';
    const result = validateExport(file, { catalog: testCatalog });
    expect(result.errors).toEqual([
      expect.objectContaining({ path: '/instances/atem1/moduleId', code: 'unknown-module' }),
    ]);
  });

  it('unknown action and feedback', () => {
    const file: any = page();
    const button = file.page.controls['0']['0'];
    button.steps['0'].action_sets.down[0].definitionId = 'teleport';
    button.feedbacks[0].definitionId = 'sparkle';
    const result = validateExport(file, { catalog: testCatalog });
    expect(result.errors.map((e) => [e.path, e.code])).toEqual([
      ['/page/controls/0/0/steps/0/action_sets/down/0/definitionId', 'unknown-action'],
      ['/page/controls/0/0/feedbacks/0/definitionId', 'unknown-feedback'],
    ]);
  });

  it('unknown and missing options carry the entity path', () => {
    const file: any = page();
    const action = file.page.controls['0']['0'].steps['0'].action_sets.down[0];
    delete action.options.input;
    action.options.bogus = { isExpression: false, value: 1 };
    const result = validateExport(file, { catalog: testCatalog });
    expect(result.errors.map((e) => [e.path, e.code]).sort()).toEqual([
      ['/page/controls/0/0/steps/0/action_sets/down/0/options/bogus', 'unknown-option'],
      ['/page/controls/0/0/steps/0/action_sets/down/0/options/input', 'missing-option'],
    ]);
  });

  it('internal entities are not checked against the module catalog', () => {
    const file: any = page();
    const button = file.page.controls['0']['0'];
    button.steps['0'].action_sets.down.push({
      type: 'action',
      id: 'w',
      definitionId: 'wait',
      connectionId: 'internal',
      options: { time: { isExpression: true, value: '500' } },
      children: {},
    });
    expect(validateExport(file, { catalog: testCatalog }).errors).toEqual([]);
  });

  it('feedback option checks are skipped when the catalog has no validateFeedbackOptions', () => {
    const { validateFeedbackOptions: _unused, ...partial } = testCatalog;
    const file: any = page();
    file.page.controls['0']['0'].feedbacks[0].options.bogus = { isExpression: false, value: 1 };
    expect(validateExport(file, { catalog: partial }).errors).toEqual([]);
    expect(validateExport(file, { catalog: testCatalog }).errors).toHaveLength(1);
  });

  it('a button built by hand with an unknown connection reference fails even without catalog', () => {
    const file = buildPageExport({
      name: 'X',
      controls: [
        {
          row: 0,
          column: 0,
          control: buildButton({
            actions: [{ connectionId: 'missing', definitionId: 'cut', options: { mixeffect: 1 } }],
          }),
        },
      ],
    });
    expect(codes(file)).toEqual(['entity-unknown-connection']);
  });
});
