import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../src/safety/json.js';
import { diffReadback } from '../../src/transport/index.js';
import { buildTestPage, clone } from './fixtures.js';

/** What Companion reports back: new entity IDs, plus the navigation buttons of an empty page. */
function companionReadback(intended: JsonObject): JsonObject {
  const actual = clone(intended);
  const control = ((actual['page'] as JsonObject)['controls'] as JsonObject)['0'] as JsonObject;
  const button = control['0'] as JsonObject;
  const action = (
    ((button['steps'] as JsonObject)['0'] as JsonObject)['action_sets'] as JsonObject
  )['down'] as JsonObject[];
  (action[0] as JsonObject)['id'] = 'ac-new-id';
  (button['feedbacks'] as JsonObject[])[0]!['id'] = 'fb-new-id';
  return actual;
}

function controlsOf(file: JsonObject): JsonObject {
  return (file['page'] as JsonObject)['controls'] as JsonObject;
}

describe('diffReadback', () => {
  it('reports no error for identical content apart from newly assigned entity IDs (measured)', () => {
    const intended = buildTestPage();
    const result = diffReadback(intended, companionReadback(intended));
    expect(result.ok).toBe(true);
    expect(result.deviations).toEqual([]);
    expect(result.summary).toEqual({ controlsIntended: 1, controlsMatched: 1, controlsDropped: 0 });
  });

  it('tolerates pinnedProperties added by the import upgrade (measured)', () => {
    const intended = buildTestPage({ withPinned: false });
    const actual = companionReadback(buildTestPage({ withPinned: true }));
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(true);
    expect(result.deviations).toEqual([]);
  });

  it('tolerates upgradeIndex inherited from the instance (measured)', () => {
    const intended = buildTestPage();
    const actual = companionReadback(intended);
    const button = (controlsOf(actual)['0'] as JsonObject)['0'] as JsonObject;
    const action = (
      ((button['steps'] as JsonObject)['0'] as JsonObject)['action_sets'] as JsonObject
    )['down'] as JsonObject[];
    (action[0] as JsonObject)['upgradeIndex'] = 5;
    expect(diffReadback(intended, actual).deviations).toEqual([]);
  });

  it('detects a silently dropped control (measured trap: legacy type in a version 17 file)', () => {
    const intended = buildTestPage();
    const actual = clone(intended);
    // Measured (B5): the slot stays empty, only Companion's own navigation buttons may remain elsewhere.
    (actual['page'] as JsonObject)['controls'] = { '1': { '0': { type: 'pagenum' } } };
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(false);
    expect(result.summary.controlsDropped).toBe(1);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0]).toMatchObject({
      kind: 'control-dropped',
      severity: 'error',
      path: 'controls.0.0',
    });
  });

  it('detects a changed value with its path', () => {
    const intended = buildTestPage({ text: 'ONE' });
    const actual = companionReadback(buildTestPage({ text: 'TWO' }));
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(false);
    const mismatch = result.deviations.find((d) => d.kind === 'value-mismatch');
    expect(mismatch?.path).toBe('controls.0.0.style.layers.2.text.value');
    expect(mismatch?.intended).toBe('ONE');
    expect(mismatch?.actual).toBe('TWO');
  });

  it('detects a changed action option', () => {
    const intended = buildTestPage();
    const actual = companionReadback(intended);
    const button = (controlsOf(actual)['0'] as JsonObject)['0'] as JsonObject;
    const action = (
      ((button['steps'] as JsonObject)['0'] as JsonObject)['action_sets'] as JsonObject
    )['down'] as JsonObject[];
    ((action[0] as JsonObject)['options'] as JsonObject)['value'] = {
      isExpression: false,
      value: '7',
    };
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(false);
    expect(result.deviations[0]?.path).toContain('steps.0.action_sets.down.0.options.value.value');
  });

  it('detects a missing property and a lost action', () => {
    const intended = buildTestPage();
    const actual = companionReadback(intended);
    const button = (controlsOf(actual)['0'] as JsonObject)['0'] as JsonObject;
    delete button['feedbacks'];
    (
      (((button['steps'] as JsonObject)['0'] as JsonObject)['action_sets'] as JsonObject)[
        'down'
      ] as unknown[]
    ).length = 0;
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(false);
    expect(result.deviations.map((d) => d.kind).sort()).toEqual([
      'missing-property',
      'value-mismatch',
    ]);
  });

  it('detects a control type mismatch', () => {
    const intended = buildTestPage();
    const actual = companionReadback(intended);
    ((controlsOf(actual)['0'] as JsonObject)['0'] as JsonObject)['type'] = 'button';
    const result = diffReadback(intended, actual);
    expect(result.deviations[0]).toMatchObject({
      kind: 'control-type-mismatch',
      severity: 'error',
    });
  });

  it('detects a different page name', () => {
    const result = diffReadback(
      buildTestPage({ pageName: 'A' }),
      companionReadback(buildTestPage({ pageName: 'B' })),
    );
    expect(result.deviations.some((d) => d.kind === 'page-name-mismatch')).toBe(true);
  });

  it('ignores navigation buttons Companion adds but warns about other extra controls', () => {
    const intended = buildTestPage();
    const actual = companionReadback(intended);
    controlsOf(actual)['1'] = { '0': { type: 'pagenum' } };
    expect(diffReadback(intended, actual).deviations).toEqual([]);
    controlsOf(actual)['2'] = { '3': { type: 'button-layered' } };
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(true);
    expect(result.deviations).toMatchObject([
      { kind: 'extra-control', severity: 'warning', path: 'controls.2.3' },
    ]);
  });

  it('reports other extra properties as warnings and can silence them', () => {
    const intended = buildTestPage();
    const actual = companionReadback(intended);
    ((controlsOf(actual)['0'] as JsonObject)['0'] as JsonObject)['newDefault'] = 1;
    const loud = diffReadback(intended, actual);
    expect(loud.ok).toBe(true);
    expect(loud.deviations).toMatchObject([{ kind: 'extra-property', severity: 'warning' }]);
    expect(diffReadback(intended, actual, { reportExtraProperties: false }).deviations).toEqual([]);
  });

  it('only tolerates id differences on entities, not on layers', () => {
    const intended = buildTestPage();
    const actual = companionReadback(intended);
    const button = (controlsOf(actual)['0'] as JsonObject)['0'] as JsonObject;
    const layers = (button['style'] as JsonObject)['layers'] as JsonObject[];
    layers[1]!['id'] = 'renamed';
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(false);
    expect(result.deviations[0]?.path).toBe('controls.0.0.style.layers.1.id');
  });

  it('accepts bare control maps and getPage-style objects on either side', () => {
    const intended = buildTestPage();
    const actual = companionReadback(intended);
    const bare = controlsOf(actual);
    expect(diffReadback(intended, { name: 'TESTPAGE', controls: bare }).deviations).toEqual([]);
    expect(diffReadback(controlsOf(intended), bare).deviations).toEqual([]);
  });

  it('counts mixed results correctly', () => {
    const intended = buildTestPage();
    controlsOf(intended)['0'] = {
      ...(controlsOf(intended)['0'] as JsonObject),
      '1': { type: 'button-layered', style: { layers: [] } },
    };
    const actual = companionReadback(intended);
    delete (controlsOf(actual)['0'] as JsonObject)['1'];
    const result = diffReadback(intended, actual);
    expect(result.summary).toEqual({ controlsIntended: 2, controlsMatched: 1, controlsDropped: 1 });
  });
});

/** A page whose entities use a module connection (file id), the built-in `internal` and the legacy `bitfocus-companion` id. */
function moduleConnectionPage(): JsonObject {
  const entity = (type: string, connectionId: string, id: string): JsonObject => ({
    id,
    type,
    definitionId: 'something',
    connectionId,
    options: { value: { isExpression: false, value: 1 } },
    upgradeIndex: 0,
    children: {},
  });
  return {
    version: 12,
    type: 'page',
    page: {
      name: 'MODULES',
      controls: {
        '0': {
          '0': {
            type: 'button-layered',
            feedbacks: [entity('feedback', 'atem-file', 'f1')],
            steps: {
              '0': {
                action_sets: {
                  down: [
                    entity('action', 'atem-file', 'a1'),
                    entity('action', 'internal', 'a2'),
                    entity('action', 'bitfocus-companion', 'a3'),
                    entity('action', 'vmix-file', 'a4'),
                  ],
                },
              },
            },
          },
        },
      },
    },
  };
}

/** What Companion 5.1.3 stores: remapped connection ids, new entity ids, no empty `children` on module entities. */
function remappedReadback(intended: JsonObject, remapping: Record<string, string>): JsonObject {
  const actual = clone(intended);
  let n = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (
      (record['type'] === 'action' || record['type'] === 'feedback') &&
      'connectionId' in record
    ) {
      const from = String(record['connectionId']);
      record['id'] = `new-${n++}`;
      record['connectionId'] = remapping[from] ?? from;
      if (from !== 'internal' && from !== 'bitfocus-companion') delete record['children'];
    }
    Object.values(record).forEach(walk);
  };
  walk(actual);
  return actual;
}

function entitiesOf(file: JsonObject): JsonObject[] {
  const button = (controlsOf(file)['0'] as JsonObject)['0'] as JsonObject;
  const down = (((button['steps'] as JsonObject)['0'] as JsonObject)['action_sets'] as JsonObject)[
    'down'
  ] as JsonObject[];
  return [...(button['feedbacks'] as JsonObject[]), ...down];
}

const REMAPPING = {
  'atem-file': 'conn-7',
  'vmix-file': 'conn-8',
  internal: 'internal',
  'bitfocus-companion': 'internal',
};

describe('diffReadback with remapped connection ids', () => {
  it('accepts the measured remapping with an explicit connectionIdMap', () => {
    const intended = moduleConnectionPage();
    const actual = remappedReadback(intended, REMAPPING);
    const result = diffReadback(intended, actual, {
      connectionIdMap: REMAPPING,
      inferConnectionIds: false,
    });
    expect(result.ok).toBe(true);
    expect(result.deviations).toEqual([]);
    expect(result.summary).toEqual({ controlsIntended: 1, controlsMatched: 1, controlsDropped: 0 });
  });

  it('infers a consistent 1:1 mapping and reports each inferred remapping once as a warning', () => {
    const intended = moduleConnectionPage();
    const actual = remappedReadback(intended, REMAPPING);
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(true);
    expect(result.deviations.map((d) => [d.kind, d.intended, d.actual])).toEqual([
      ['connection-remapped', 'atem-file', 'conn-7'],
      ['connection-remapped', 'bitfocus-companion', 'internal'],
      ['connection-remapped', 'vmix-file', 'conn-8'],
    ]);
    expect(result.deviations.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('treats an empty children object and an absent one as equal in both directions', () => {
    const intended = moduleConnectionPage();
    const actual = remappedReadback(intended, {});
    // Intended lacks children, actual has an empty one.
    const without = clone(intended);
    for (const entity of entitiesOf(without)) delete entity['children'];
    expect(diffReadback(without, intended).deviations).toEqual([]);
    expect(diffReadback(intended, actual).deviations).toEqual([]);
  });

  it('still reports non-empty children that were lost', () => {
    const intended = moduleConnectionPage();
    entitiesOf(intended)[0]!['children'] = { actions: [{ id: 'x' }] };
    const actual = remappedReadback(intended, {});
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(false);
    expect(result.deviations[0]).toMatchObject({ kind: 'missing-property' });
  });

  it('rejects a connectionId that differs from the explicit mapping', () => {
    const intended = moduleConnectionPage();
    const actual = remappedReadback(intended, REMAPPING);
    entitiesOf(actual)[0]!['connectionId'] = 'conn-99';
    const result = diffReadback(intended, actual, { connectionIdMap: REMAPPING });
    expect(result.ok).toBe(false);
    expect(result.deviations).toMatchObject([
      { kind: 'value-mismatch', severity: 'error', intended: 'atem-file', actual: 'conn-99' },
    ]);
  });

  it('without a map, an unmapped id must match when inference is off', () => {
    const intended = moduleConnectionPage();
    const actual = remappedReadback(intended, REMAPPING);
    const result = diffReadback(intended, actual, { inferConnectionIds: false });
    expect(result.ok).toBe(false);
    expect(result.deviations.every((d) => d.kind === 'value-mismatch')).toBe(true);
  });

  it('keeps contradictions as errors: one file id mapped to two different actual ids', () => {
    const intended = moduleConnectionPage();
    const actual = remappedReadback(intended, REMAPPING);
    entitiesOf(actual)[1]!['connectionId'] = 'conn-9'; // atem-file was conn-7 on the feedback
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(false);
    expect(result.deviations.filter((d) => d.severity === 'error')).toHaveLength(1);
  });

  it('keeps contradictions as errors: two file ids mapped to one module connection', () => {
    const intended = moduleConnectionPage();
    const actual = remappedReadback(intended, { ...REMAPPING, 'vmix-file': 'conn-7' });
    const result = diffReadback(intended, actual);
    expect(result.ok).toBe(false);
    expect(result.deviations.some((d) => d.kind === 'value-mismatch')).toBe(true);
  });

  it('never accepts a module connection becoming internal, or internal becoming a module connection', () => {
    const intended = moduleConnectionPage();
    const toInternal = remappedReadback(intended, { ...REMAPPING, 'atem-file': 'internal' });
    expect(diffReadback(intended, toInternal).ok).toBe(false);
    const fromInternal = remappedReadback(intended, { ...REMAPPING, internal: 'conn-5' });
    expect(diffReadback(intended, fromInternal).ok).toBe(false);
  });

  it('keeps the strict cases with remapping: dropped control, type mismatch and value changes', () => {
    const intended = moduleConnectionPage();
    const options = { connectionIdMap: REMAPPING, inferConnectionIds: false };
    const dropped = remappedReadback(intended, REMAPPING);
    (dropped['page'] as JsonObject)['controls'] = {};
    expect(diffReadback(intended, dropped, options).deviations[0]).toMatchObject({
      kind: 'control-dropped',
    });
    const typed = remappedReadback(intended, REMAPPING);
    ((controlsOf(typed)['0'] as JsonObject)['0'] as JsonObject)['type'] = 'button';
    expect(diffReadback(intended, typed, options).deviations[0]).toMatchObject({
      kind: 'control-type-mismatch',
    });
    const changed = remappedReadback(intended, REMAPPING);
    ((entitiesOf(changed)[0]!['options'] as JsonObject)['value'] as JsonObject)['value'] = 2;
    const result = diffReadback(intended, changed, options);
    expect(result.ok).toBe(false);
    expect(result.deviations[0]).toMatchObject({ kind: 'value-mismatch', actual: 2 });
  });
});
