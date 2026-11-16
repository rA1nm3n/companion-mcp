import { describe, expect, it } from 'vitest';
import {
  findAction,
  getModule,
  listFullModuleIds,
  listModules,
  listUnusable,
  searchModules,
  validateActionOptions,
} from '../../src/catalog/index.js';

describe('full catalog coverage', () => {
  it('has full data for every module of the index', () => {
    const notFull = listModules().filter((m) => m.kind !== 'full');
    expect(notFull.map((m) => m.moduleId)).toEqual([]);
    expect(listFullModuleIds().length).toBe(listModules().length);
  });

  it('records legacy modules without a manifest as unusable', () => {
    const dirs = listUnusable().map((u) => u.directory);
    expect(dirs).toEqual(expect.arrayContaining(['datavideo-visca', 'greenhippo-hippotizer']));
    expect(listModules().some((m) => m.moduleId === 'datavideo-visca')).toBe(false);
  });

  it('gives every module at least one action or feedback with provenance', () => {
    for (const id of listFullModuleIds()) {
      const mod = getModule(id);
      expect(mod, id).toBeDefined();
      const entries = [...(mod?.actions ?? []), ...(mod?.feedbacks ?? [])];
      expect(entries.length, id).toBeGreaterThan(0);
      for (const e of entries) expect(e.provenance.line, `${id}/${e.id}`).toBeGreaterThan(0);
    }
  });

  it.each([
    ['obs-studio', 42, 36],
    ['figure53-qlab-advance', 67, 19],
    ['generic-osc', 8, 9],
    ['generic-artnet', 4, 1],
    ['generic-sacn', 7, 4],
    ['generic-http', 5, 1],
    ['sony-visca', 191, 21],
    ['disguise-osc', 35, 9],
  ])('%s has %i actions and %i feedbacks', (id, actions, feedbacks) => {
    const mod = getModule(id);
    expect(mod?.actions.length).toBe(actions);
    expect(mod?.feedbacks.length).toBe(feedbacks);
  });

  it('finds modules of the new areas by search', () => {
    expect(searchModules('qlab').map((m) => m.moduleId)).toContain('figure53-qlab-advance');
    expect(searchModules('propresenter').length).toBeGreaterThan(0);
    expect(searchModules('novastar').length).toBeGreaterThanOrEqual(6);
  });

  it('validates options of a newly catalogued module', () => {
    expect(findAction('generic-http', 'get')).toBeDefined();
    expect(validateActionOptions('generic-http', 'get', {})).toEqual([]);
    const unknown = validateActionOptions('generic-http', 'get', {
      bogus: { isExpression: false, value: 1 },
    });
    expect(unknown.map((i) => i.code)).toEqual(['unknown-option']);
    expect(validateActionOptions('generic-http', 'nope', {}).map((i) => i.code)).toEqual([
      'unknown-action',
    ]);
  });
});
