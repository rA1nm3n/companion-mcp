import { describe, expect, it } from 'vitest';
import {
  atemSwitcherPage,
  birddogPresetPage,
  createSequentialIdGenerator,
  showpaceTimerPage,
  validateExport,
  videohubRoutingPage,
  vmixInputPage,
  type PageExport,
} from '../../src/format/index.js';
import {
  findAction,
  findFeedback,
  validateActionOptions,
  validateFeedbackOptions,
} from '../../src/catalog/index.js';
import { catalogLookup } from '../../src/tools/catalog-adapter.js';
import { testCatalog } from './helpers/test-catalog.js';

const connection = (id = 'c1', label = 'dev') => ({ id, label });
const ids = () => createSequentialIdGenerator();

function expectValid(file: PageExport): void {
  const plain = validateExport(file);
  expect(plain.errors).toEqual([]);
  const withCatalog = validateExport(file, { catalog: testCatalog });
  expect(withCatalog.errors).toEqual([]);
  // survives serialization like a real .companionconfig file
  expect(validateExport(JSON.stringify(file)).errors).toEqual([]);
}

const at = (file: PageExport, row: number, column: number) =>
  file.page.controls[String(row)]?.[String(column)] as any;

describe('atemSwitcherPage', () => {
  it('8 inputs: program row 0, preview row 1, CUT and AUTO row 2', () => {
    const file = atemSwitcherPage({
      connection: connection('atem1', 'atem'),
      inputs: 8,
      ids: ids(),
    });
    expectValid(file);
    expect(file.page.name).toBe('ATEM Switcher');
    expect(Object.keys(file.page.controls)).toEqual(['0', '1', '2']);
    expect(Object.keys(file.page.controls['0'] ?? {})).toHaveLength(8);
    expect(file.instances.atem1).toMatchObject({
      moduleId: 'bmd-atem',
      label: 'atem',
      updatePolicy: 'manual',
    });
  });

  it('program button: action, feedback options and colors', () => {
    const file = atemSwitcherPage({
      connection: connection(),
      inputs: [3],
      mixEffect: 2,
      ids: ids(),
    });
    const program = at(file, 0, 0);
    expect(program.steps['0'].action_sets.down[0]).toMatchObject({
      connectionId: 'c1',
      definitionId: 'program',
      options: {
        mixeffect: { isExpression: false, value: 2 },
        input: { isExpression: false, value: 3 },
      },
    });
    const feedback = program.feedbacks[0];
    expect(feedback.definitionId).toBe('program');
    expect(feedback.styleOverrides.map((o: any) => o.override.value)).toEqual([0xff0000, 0xffffff]);
    const preview = at(file, 1, 0);
    expect(preview.steps['0'].action_sets.down[0].definitionId).toBe('preview');
    expect(preview.feedbacks[0].styleOverrides[0].override.value).toBe(0x00ff00);
  });

  it('labels and custom colors', () => {
    const file = atemSwitcherPage({
      connection: connection(),
      inputs: [{ input: 1, label: 'HOST' }, 2],
      programColor: 0xaa0000,
      previewColor: 0x00aa00,
      pageName: 'Mein Mixer',
      ids: ids(),
    });
    expectValid(file);
    expect(file.page.name).toBe('Mein Mixer');
    const text = at(file, 0, 0).style.layers[2].text;
    expect(text.value).toBe('HOST');
    expect(at(file, 0, 1).style.layers[2].text.value).toBe('2');
    expect(at(file, 0, 0).feedbacks[0].styleOverrides[0].override.value).toBe(0xaa0000);
  });

  it('transitions can be switched off', () => {
    const file = atemSwitcherPage({
      connection: connection(),
      inputs: 2,
      transitions: false,
      ids: ids(),
    });
    expectValid(file);
    expect(Object.keys(file.page.controls)).toEqual(['0', '1']);
  });

  it('CUT and AUTO run the right actions', () => {
    const file = atemSwitcherPage({ connection: connection(), inputs: 2, ids: ids() });
    expect(at(file, 2, 0).steps['0'].action_sets.down[0].definitionId).toBe('cut');
    expect(at(file, 2, 1).steps['0'].action_sets.down[0].definitionId).toBe('auto');
  });

  it('single input', () => {
    expectValid(atemSwitcherPage({ connection: connection(), inputs: 1, ids: ids() }));
  });

  it('more inputs than columns wrap into rows, in separate program and preview blocks', () => {
    const file = atemSwitcherPage({ connection: connection(), inputs: 10, ids: ids() });
    expectValid(file);
    expect(at(file, 1, 1)).toBeDefined(); // input 10 of the program block, second row
    expect(at(file, 2, 0).steps['0'].action_sets.down[0].definitionId).toBe('preview');
    expect(at(file, 4, 0).steps['0'].action_sets.down[0].definitionId).toBe('cut');
  });

  it('navigation shifts the layout to column 1 and keeps the file valid', () => {
    const file = atemSwitcherPage({
      connection: connection(),
      inputs: 7,
      navigation: true,
      ids: ids(),
    });
    expectValid(file);
    expect(at(file, 0, 0)).toEqual({ type: 'pageup' });
    expect(at(file, 0, 1).steps['0'].action_sets.down[0].options.input.value).toBe(1);
    expect(at(file, 0, 7)).toBeDefined();
  });

  it('inputs given as ids list', () => {
    const file = atemSwitcherPage({ connection: connection(), inputs: [1, 2, 3010], ids: ids() });
    expectValid(file);
    expect(at(file, 0, 2).steps['0'].action_sets.down[0].options.input.value).toBe(3010);
  });

  it('rejects empty or invalid input specs', () => {
    expect(() => atemSwitcherPage({ connection: connection(), inputs: [] })).toThrow(
      /must not be empty/,
    );
    expect(() => atemSwitcherPage({ connection: connection(), inputs: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => atemSwitcherPage({ connection: connection(), inputs: 2, mixEffect: 0 })).toThrow(
      /mixEffect/,
    );
    expect(() => atemSwitcherPage({ connection: connection(), inputs: 2, columns: 0 })).toThrow(
      /columns/,
    );
  });

  it('connection settings are passed through', () => {
    const file = atemSwitcherPage({
      connection: { id: 'x', label: 'atem', updatePolicy: 'stable', lastUpgradeIndex: 7 },
      inputs: 1,
      ids: ids(),
    });
    expect(file.instances.x).toMatchObject({ updatePolicy: 'stable', lastUpgradeIndex: 7 });
  });
});

describe('videohubRoutingPage', () => {
  it('4 x 3 matrix: label column plus one button per input and output', () => {
    const file = videohubRoutingPage({
      connection: connection('vh', 'videohub'),
      inputs: 4,
      outputs: 3,
      ids: ids(),
    });
    expectValid(file);
    expect(Object.keys(file.page.controls)).toEqual(['0', '1', '2']);
    expect(Object.keys(file.page.controls['1'] ?? {})).toHaveLength(5);
    expect(file.instances.vh?.moduleId).toBe('bmd-videohub');
  });

  it('route action and feedback address the matching input and output', () => {
    const file = videohubRoutingPage({
      connection: connection(),
      inputs: [{ input: 5, label: 'CAM' }],
      outputs: [{ input: 2, label: 'MON' }],
      ids: ids(),
    });
    expectValid(file);
    expect(at(file, 0, 0).style.layers[2].text.value).toBe('MON');
    const button = at(file, 0, 1);
    expect(button.steps['0'].action_sets.down[0].options).toEqual({
      source: { isExpression: false, value: 5 },
      destination: { isExpression: false, value: 2 },
      ignore_lock: { isExpression: false, value: false },
    });
    expect(button.feedbacks[0]).toMatchObject({
      definitionId: 'input_bg',
      options: { input: { value: 5 }, output: { value: 2 } },
    });
    expect(button.style.layers[2].text.value).toBe('CAM');
  });

  it('a 20x20 matrix grows the grid and warns, but stays valid', () => {
    const file = videohubRoutingPage({
      connection: connection(),
      inputs: 20,
      outputs: 20,
      ids: ids(),
    });
    const result = validateExport(file, { catalog: testCatalog });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['grid-exceeds-default']);
    expect(file.page.gridSize).toMatchObject({ maxColumn: 20, maxRow: 19 });
  });

  it('navigation and ignore lock', () => {
    const file = videohubRoutingPage({
      connection: connection(),
      inputs: 2,
      outputs: 2,
      navigation: true,
      ignoreLock: true,
      ids: ids(),
    });
    expectValid(file);
    expect(at(file, 1, 2).steps['0'].action_sets.down[0].options.ignore_lock.value).toBe(true);
  });

  it('requires inputs and outputs', () => {
    expect(() =>
      videohubRoutingPage({ connection: connection(), inputs: [], outputs: 2 }),
    ).toThrow();
    expect(() =>
      videohubRoutingPage({ connection: connection(), inputs: 2, outputs: 0 }),
    ).toThrow();
  });
});

describe('vmixInputPage', () => {
  it('preview row and program row with tally feedbacks', () => {
    const file = vmixInputPage({ connection: connection('vm', 'vmix'), inputs: 4, ids: ids() });
    expectValid(file);
    expect(file.instances.vm?.moduleId).toBe('studiocoast-vmix');
    const preview = at(file, 0, 1);
    expect(preview.steps['0'].action_sets.down[0]).toMatchObject({
      definitionId: 'previewInput',
      options: { input: { value: '2' }, mix: { value: 1 } },
    });
    const program = at(file, 1, 1);
    expect(program.steps['0'].action_sets.down[0].definitionId).toBe('programCut');
    expect(program.feedbacks[0].definitionId).toBe('inputLive');
  });

  it('advanced feedbacks reference the module result properties and carry the colors as options', () => {
    const file = vmixInputPage({
      connection: connection(),
      inputs: ['Camera 1'],
      programColor: 0xcc0000,
      ids: ids(),
    });
    const feedback = at(file, 1, 0).feedbacks[0];
    expect(feedback.styleOverrides.map((o: any) => [o.elementProperty, o.override.value])).toEqual([
      ['color', 'bgcolor'],
      ['color', 'color'],
    ]);
    expect(feedback.options.bg.value).toBe(0xcc0000);
    expect(feedback.options.input.value).toBe('Camera 1');
  });

  it('mix Selected and labels, without program row', () => {
    const file = vmixInputPage({
      connection: connection(),
      inputs: [{ input: 'GUID-X', label: 'Host' }],
      mix: 'Selected',
      programRow: false,
      ids: ids(),
    });
    expectValid(file);
    expect(Object.keys(file.page.controls)).toEqual(['0']);
    expect(at(file, 0, 0).steps['0'].action_sets.down[0].options.mix.value).toBe('Selected');
    expect(at(file, 0, 0).style.layers[2].text.value).toBe('Host');
  });

  it('wraps long input lists', () => {
    const file = vmixInputPage({ connection: connection(), inputs: 12, columns: 6, ids: ids() });
    expectValid(file);
    expect(at(file, 1, 5)).toBeDefined();
    expect(at(file, 2, 0).steps['0'].action_sets.down[0].definitionId).toBe('programCut');
  });
});

describe('birddogPresetPage', () => {
  it('one recall button per preset', () => {
    const file = birddogPresetPage({
      connection: connection('bd', 'cam1'),
      presets: 10,
      ids: ids(),
    });
    expectValid(file);
    expect(file.instances.bd?.moduleId).toBe('birddog-ptz');
    expect(at(file, 1, 1).steps['0'].action_sets.down[0]).toMatchObject({
      definitionId: 'recallPset',
      options: { val: { isExpression: false, value: '10' } },
    });
    expect(at(file, 0, 0).feedbacks).toEqual([]);
  });

  it('labels, columns and button color', () => {
    const file = birddogPresetPage({
      connection: connection(),
      presets: [{ input: 1, label: 'WIDE' }, { input: 64 }],
      columns: 1,
      buttonColor: 0x112233,
      ids: ids(),
    });
    expectValid(file);
    expect(at(file, 0, 0).style.layers[2].text.value).toBe('WIDE');
    expect(at(file, 1, 0).style.layers[2].text.value).toBe('PRESET 64');
    expect(at(file, 0, 0).style.layers[1].color.value).toBe(0x112233);
  });

  it('rejects presets outside the recall range', () => {
    expect(() => birddogPresetPage({ connection: connection(), presets: [65] })).toThrow(/1 to 64/);
    expect(() => birddogPresetPage({ connection: connection(), presets: [0] })).toThrow(
      /positive integer/,
    );
  });
});

describe('showpaceTimerPage', () => {
  // The small test catalog above does not know ShowPace: validate against the real catalog.
  const expectValidReal = (file: PageExport): void => {
    expect(validateExport(file, { catalog: catalogLookup }).errors).toEqual([]);
    expect(validateExport(JSON.stringify(file)).errors).toEqual([]);
  };
  const entities = (file: PageExport): Array<{ kind: 'action' | 'feedback'; entity: any }> => {
    const found: Array<{ kind: 'action' | 'feedback'; entity: any }> = [];
    for (const row of Object.values(file.page.controls)) {
      for (const button of Object.values(row ?? {}) as any[]) {
        for (const set of Object.values(button.steps ?? {}) as any[]) {
          for (const list of Object.values(set.action_sets ?? {}) as any[][]) {
            for (const entity of list) found.push({ kind: 'action', entity });
          }
        }
        for (const entity of button.feedbacks ?? []) found.push({ kind: 'feedback', entity });
      }
    }
    return found;
  };

  it('is valid against the real catalog (every action and feedback id and option)', () => {
    const file = showpaceTimerPage({
      connection: connection('sp', 'showpace'),
      tempoSteps: [90, 110, 135],
      ids: ids(),
    });
    expect(validateExport(file, { catalog: catalogLookup }).errors).toEqual([]);
    expectValidReal(file);
    expect(file.instances.sp).toMatchObject({ moduleId: 'showpace-timer', label: 'showpace' });
    const all = entities(file);
    expect(all.length).toBeGreaterThan(10);
    for (const { kind, entity } of all) {
      const issues =
        kind === 'action'
          ? validateActionOptions('showpace-timer', entity.definitionId, entity.options)
          : validateFeedbackOptions('showpace-timer', entity.definitionId, entity.options);
      expect(issues, `${kind} ${entity.definitionId}`).toEqual([]);
      expect(
        kind === 'action'
          ? findAction('showpace-timer', entity.definitionId)
          : findFeedback('showpace-timer', entity.definitionId),
        `${kind} ${entity.definitionId}`,
      ).toBeDefined();
    }
  });

  it('layout: display row, transport, rundown, tempo, direct tempo steps', () => {
    const file = showpaceTimerPage({ connection: connection(), ids: ids() });
    expect(Object.keys(file.page.controls)).toEqual(['0', '1', '2', '3', '4']);
    expect(at(file, 1, 0).steps['0'].action_sets.down[0].definitionId).toBe('timer_start');
    expect(at(file, 1, 1).steps['0'].action_sets.down[0].definitionId).toBe('timer_pause');
    expect(at(file, 1, 2).steps['0'].action_sets.down[0].definitionId).toBe('timer_reset');
    expect(at(file, 2, 0).steps['0'].action_sets.down[0].definitionId).toBe('rundown_prev');
    expect(at(file, 2, 1).steps['0'].action_sets.down[0].definitionId).toBe('rundown_next');
    expect(at(file, 3, 0).steps['0'].action_sets.down[0].definitionId).toBe('tempo_down');
    expect(at(file, 3, 1).steps['0'].action_sets.down[0].definitionId).toBe('tempo_up');
    expect(at(file, 3, 2).steps['0'].action_sets.down[0].definitionId).toBe('tempo_reset');
    expect(at(file, 4, 2).steps['0'].action_sets.down[0]).toMatchObject({
      definitionId: 'tempo_set',
      options: { pct: { isExpression: false, value: 135 } },
    });
  });

  it('display shows the remaining time as a variable with the four phase feedbacks', () => {
    const file = showpaceTimerPage({ connection: connection('c', 'timer'), ids: ids() });
    const display = at(file, 0, 0);
    expect(display.style.layers[2].text).toMatchObject({
      isExpression: true,
      value: '`$(timer:remaining)`',
    });
    expect(display.feedbacks.map((f: any) => f.options.phase.value)).toEqual([
      'normal',
      'warning',
      'critical',
      'overtime',
    ]);
    expect(at(file, 0, 3).feedbacks[0].definitionId).toBe('tempo_changed');
  });

  it('display and direct tempo steps can be switched off', () => {
    const file = showpaceTimerPage({
      connection: connection(),
      display: false,
      tempoSteps: [],
      ids: ids(),
    });
    expectValidReal(file);
    expect(Object.keys(file.page.controls)).toEqual(['0', '1', '2']);
  });

  it('narrow grids wrap and navigation shifts the layout', () => {
    const file = showpaceTimerPage({
      connection: connection(),
      columns: 2,
      navigation: true,
      ids: ids(),
    });
    expectValidReal(file);
    expect(validateExport(file, { catalog: catalogLookup }).errors).toEqual([]);
    expect(at(file, 0, 0)).toEqual({ type: 'pageup' });
    expect(at(file, 0, 2).style.layers[2].text.value).toContain('segment_title');
  });

  it('rejects tempo steps outside the range of tempo_set', () => {
    expect(() => showpaceTimerPage({ connection: connection(), tempoSteps: [49] })).toThrow(
      /tempoSteps/,
    );
    expect(() => showpaceTimerPage({ connection: connection(), tempoSteps: [201] })).toThrow(
      /tempoSteps/,
    );
  });

  it('showpace page snapshot (default)', () => {
    expect(
      showpaceTimerPage({
        connection: connection('sp', 'showpace'),
        companionBuild: 'test',
        ids: ids(),
      }),
    ).toMatchSnapshot();
  });
});

describe('determinism and snapshots', () => {
  it('same parameters and generator give byte-identical JSON', () => {
    const make = () =>
      JSON.stringify(atemSwitcherPage({ connection: connection(), inputs: 4, ids: ids() }));
    expect(make()).toBe(make());
  });

  it('default random IDs change the output but never the structure', () => {
    const a = atemSwitcherPage({ connection: connection(), inputs: 2 });
    const b = atemSwitcherPage({ connection: connection(), inputs: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(Object.keys(a.page.controls)).toEqual(Object.keys(b.page.controls));
    expectValid(a);
  });

  it('all entity and layer ids of a generated page are unique', () => {
    const file = videohubRoutingPage({ connection: connection(), inputs: 4, outputs: 4 });
    const seen = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.id === 'string' && 'type' in record) {
          expect(seen.has(record.id), record.id).toBe(false);
          seen.add(record.id);
        }
        Object.values(record).forEach(walk);
      }
    };
    walk(file.page.controls);
    expect(seen.size).toBeGreaterThan(40);
  });

  it('atem page snapshot (2 inputs)', () => {
    expect(
      atemSwitcherPage({
        connection: connection('atem1', 'atem'),
        inputs: 2,
        companionBuild: 'test',
        ids: ids(),
      }),
    ).toMatchSnapshot();
  });

  it('birddog page snapshot (2 presets)', () => {
    expect(
      birddogPresetPage({ connection: connection('bd', 'cam'), presets: 2, ids: ids() }),
    ).toMatchSnapshot();
  });
});
