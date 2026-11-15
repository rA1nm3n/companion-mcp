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
