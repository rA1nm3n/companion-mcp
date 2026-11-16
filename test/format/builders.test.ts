import { describe, expect, it } from 'vitest';
import {
  type FeedbackEntity,
  FILE_VERSION,
  buildAction,
  buildButton,
  buildConnection,
  buildPageExport,
  buildTriggerExport,
  createSequentialIdGenerator,
  expr,
  fitGrid,
  randomIdGenerator,
  toOptions,
  val,
  validateExport,
} from '../../src/format/index.js';

describe('buildConnection', () => {
  it('defaults updatePolicy to manual and lastUpgradeIndex to -1', () => {
    expect(buildConnection({ moduleId: 'bmd-atem', label: 'atem' })).toEqual({
      label: 'atem',
      moduleId: 'bmd-atem',
      lastUpgradeIndex: -1,
      moduleVersionId: null,
      updatePolicy: 'manual',
      sortOrder: 0,
    });
  });

  it('keeps explicit values', () => {
    const connection = buildConnection({
      moduleId: 'bmd-atem',
      label: 'atem',
      updatePolicy: 'stable',
      lastUpgradeIndex: 3,
      moduleVersionId: '4.5.0',
      sortOrder: 2,
      collectionId: 'g1',
    });
    expect(connection).toMatchObject({
      updatePolicy: 'stable',
      lastUpgradeIndex: 3,
      moduleVersionId: '4.5.0',
      sortOrder: 2,
      collectionId: 'g1',
    });
  });
});

describe('ID generation', () => {
  it('sequential generator is deterministic and counts per kind', () => {
    const ids = createSequentialIdGenerator();
    expect([ids('element'), ids('element'), ids('action'), ids('element')]).toEqual([
      'element-1',
      'element-2',
      'action-1',
      'element-3',
    ]);
    expect(createSequentialIdGenerator('t-')('action')).toBe('t-action-1');
  });

  it('random generator yields 21 URL-safe characters and no repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = randomIdGenerator('element');
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(2000);
  });
});

describe('option wrapping', () => {
  it('wraps raw values and passes wrapped values through', () => {
    expect(
      toOptions({
        a: 1,
        b: 'x',
        c: true,
        d: null,
        e: expr('1 + 1'),
        f: val([1, 2]),
        g: { isExpression: false },
      }),
    ).toEqual({
      a: { isExpression: false, value: 1 },
      b: { isExpression: false, value: 'x' },
      c: { isExpression: false, value: true },
      d: { isExpression: false, value: null },
      e: { isExpression: true, value: '1 + 1' },
      f: { isExpression: false, value: [1, 2] },
      g: { isExpression: false },
    });
  });

  it('wraps plain objects that merely resemble a wrapper (value-only objects)', () => {
    expect(toOptions({ o: { value: 1 } })).toEqual({
      o: { isExpression: false, value: { value: 1 } },
    });
  });

  it('rejects a malformed wrapper (expression with non-string value)', () => {
    expect(() => toOptions({ a: { isExpression: true, value: 5 } })).toThrow(/"a"/);
  });
});

describe('buildButton', () => {
  const ids = () => createSequentialIdGenerator();

  it('creates a button-layered control with canvas, background and text layers', () => {
    const button = buildButton({ text: 'CAM 1', ids: ids() });
    expect(button.type).toBe('button-layered');
    expect(button.style.layers.map((l) => l.type)).toEqual(['canvas', 'box', 'text']);
    expect(button.style.layers.map((l) => l.id)).toEqual(['element-1', 'element-2', 'element-3']);
    expect(button.steps['0']?.action_sets).toEqual({ down: [], up: [] });
  });

  it('is deterministic for the same generator state', () => {
    const input = {
      text: 'A',
      actions: [{ connectionId: 'internal', definitionId: 'wait', options: { time: expr('100') } }],
      feedbacks: [
        {
          connectionId: 'internal',
          definitionId: 'check_expression',
          options: { expression: expr('1') },
          style: { bgColor: 1 },
        },
      ],
    };
    expect(buildButton({ ...input, ids: ids() })).toEqual(buildButton({ ...input, ids: ids() }));
  });

  it('feedback overrides point at the background and text layer of the same button', () => {
    const button = buildButton({
      ids: ids(),
      feedbacks: [
        {
          connectionId: 'internal',
          definitionId: 'check_expression',
          options: { expression: expr('1') },
          style: { bgColor: 0xff0000, textColor: 0 },
        },
      ],
    });
    const [canvas, background, text] = button.style.layers;
    expect(canvas?.type).toBe('canvas');
    expect(button.feedbacks[0]).toMatchObject({
      isInverted: { isExpression: false, value: false },
      styleOverrides: [
        { elementId: background?.id, elementProperty: 'color', override: val(0xff0000) },
        { elementId: text?.id, elementProperty: 'color', override: val(0) },
      ],
    });
  });

  it('advanced feedbacks name the result property in the override', () => {
    const button = buildButton({
      ids: ids(),
      feedbacks: [
        {
          connectionId: 'internal',
          definitionId: 'x',
          style: { bgFromResult: 'bgcolor', textFromResult: 'color' },
        },
      ],
    });
    const feedback = button.feedbacks[0] as FeedbackEntity;
    expect(feedback.styleOverrides?.map((o) => o.override.value)).toEqual(['bgcolor', 'color']);
  });

  it('text expression wins over text and is flagged as an expression', () => {
    const button = buildButton({ text: 'ignored', textExpression: '`A ${1}`', ids: ids() });
    const text = button.style.layers[2];
    expect(text?.type === 'text' && text.text).toEqual({ isExpression: true, value: '`A ${1}`' });
  });

  it('every action and feedback gets its own id', () => {
    const button = buildButton({
      ids: ids(),
      actions: [
        { connectionId: 'internal', definitionId: 'a' },
        { connectionId: 'internal', definitionId: 'b' },
      ],
      actionsUp: [{ connectionId: 'internal', definitionId: 'c' }],
    });
    const all = [
      ...(button.steps['0']?.action_sets.down ?? []),
      ...(button.steps['0']?.action_sets.up ?? []),
    ].map((a) => a.id);
    expect(new Set(all).size).toBe(3);
  });

  it('buildAction keeps optional headline and disabled', () => {
    expect(
      buildAction(
        { connectionId: 'internal', definitionId: 'x', headline: 'H', disabled: true },
        ids(),
      ),
    ).toMatchObject({ headline: 'H', disabled: true, options: {} });
  });
});

describe('buildPageExport', () => {
  const button = () => buildButton({ ids: createSequentialIdGenerator() });

  it('writes version 12, type page and the same top-level keys as Companion exports', () => {
    const file = buildPageExport({
      name: 'P',
      controls: [{ row: 0, column: 0, control: button() }],
    });
    expect(file.version).toBe(FILE_VERSION);
    expect(Object.keys(file).sort()).toEqual(
      [
        'connectionCollections',
        'imageLibrary',
        'imageLibraryCollections',
        'instances',
        'oldPageNumber',
        'page',
        'type',
        'version',
      ].sort(),
    );
    expect(file.page.gridSize).toEqual({ minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 });
    expect(validateExport(file).errors).toEqual([]);
  });

  it('throws on duplicate positions', () => {
    expect(() =>
      buildPageExport({
        name: 'P',
        controls: [
          { row: 1, column: 2, control: button() },
          { row: 1, column: 2, control: button() },
        ],
      }),
    ).toThrow(/duplicate control at row 1, column 2/);
  });

  it('throws on non-integer positions', () => {
    expect(() =>
      buildPageExport({ name: 'P', controls: [{ row: 0.5, column: 0, control: button() }] }),
    ).toThrow(/integers/);
  });

  it('grows the grid to fit controls beyond 8x4', () => {
    const file = buildPageExport({
      name: 'P',
      controls: [{ row: 5, column: 11, control: button() }],
    });
    expect(file.page.gridSize).toEqual({ minColumn: 0, maxColumn: 11, minRow: 0, maxRow: 5 });
    const result = validateExport(file);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['grid-exceeds-default']);
  });

  it('an explicit grid that is too small is caught by the validator', () => {
    const file = buildPageExport({
      name: 'P',
      gridSize: { minColumn: 0, maxColumn: 1, minRow: 0, maxRow: 1 },
      controls: [{ row: 3, column: 0, control: button() }],
    });
    expect(validateExport(file).errors.map((e) => e.code)).toEqual(['coordinates-out-of-grid']);
  });

  it('adds navigation buttons at column 0 when requested', () => {
    const file = buildPageExport({
      name: 'P',
      navigation: true,
      controls: [{ row: 0, column: 1, control: button() }],
    });
    expect(file.page.controls['0']?.['0']).toEqual({ type: 'pageup' });
    expect(file.page.controls['1']?.['0']).toEqual({ type: 'pagenum' });
    expect(file.page.controls['2']?.['0']).toEqual({ type: 'pagedown' });
    expect(validateExport(file).errors).toEqual([]);
  });

  it('navigation collides with a control at column 0, row 0', () => {
    expect(() =>
      buildPageExport({
        name: 'P',
        navigation: true,
        controls: [{ row: 0, column: 0, control: button() }],
      }),
    ).toThrow(/duplicate/);
  });

  it('supports negative positions by growing the grid', () => {
    expect(fitGrid([{ row: -1, column: -2 }])).toEqual({
      minColumn: -2,
      maxColumn: 7,
      minRow: -1,
      maxRow: 3,
    });
  });

  it('keeps optional header fields only when given', () => {
    const plain = buildPageExport({ name: 'P', controls: [] });
    expect('companionBuild' in plain).toBe(false);
    expect('notes' in plain).toBe(false);
    expect('id' in plain.page).toBe(false);
    const rich = buildPageExport({
      name: 'P',
      controls: [],
      companionBuild: 'x',
      notes: 'n',
      pageId: 'pg1',
      oldPageNumber: 4,
    });
    expect(rich).toMatchObject({ companionBuild: 'x', notes: 'n', oldPageNumber: 4 });
    expect(rich.page.id).toBe('pg1');
  });

  it('an empty page is valid', () => {
    expect(validateExport(buildPageExport({ name: 'Empty', controls: [] })).ok).toBe(true);
  });

  it('JSON output survives a serialize/parse cycle unchanged', () => {
    const file = buildPageExport({
      name: 'P',
      controls: [{ row: 0, column: 0, control: button() }],
    });
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });
});

describe('buildTriggerExport', () => {
  it('writes version 12, type trigger_list, disabled triggers by default', () => {
    const file = buildTriggerExport({
      ids: createSequentialIdGenerator(),
      triggers: [{ name: 'T' }, { name: 'U' }],
    });
    expect(file.version).toBe(12);
    expect(file.type).toBe('trigger_list');
    expect(Object.keys(file.triggers)).toEqual(['trigger-1', 'trigger-2']);
    expect(file.triggers['trigger-1']?.options).toEqual({
      name: 'T',
      enabled: false,
      sortOrder: 0,
    });
    expect(validateExport(file).errors).toEqual([]);
  });

  it('throws on duplicate trigger ids', () => {
    expect(() =>
      buildTriggerExport({
        triggers: [
          { id: 'a', name: 'T' },
          { id: 'a', name: 'U' },
        ],
      }),
    ).toThrow(/Duplicate trigger id/);
  });

  it('event options stay raw', () => {
    const file = buildTriggerExport({
      ids: createSequentialIdGenerator(),
      triggers: [{ name: 'T', events: [{ type: 'interval', options: { seconds: 5 } }] }],
    });
    expect(file.triggers['trigger-1']?.events[0]).toEqual({
      id: 'event-1',
      type: 'interval',
      enabled: true,
      options: { seconds: 5 },
    });
  });
});
