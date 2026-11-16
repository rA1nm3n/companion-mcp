import { describe, expect, it } from 'vitest';
import {
  findAction,
  findFeedback,
  getIndex,
  getModule,
  listNoModule,
  searchModules,
  validateActionOptions,
  validateFeedbackOptions,
} from '../../src/catalog/index.js';

const lit = (value: unknown) => ({ isExpression: false, value });
const expr = (value: unknown) => ({ isExpression: true, value });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('media and pixel modules: data', () => {
  it.each([
    ['touch-designer', 2, 1],
    ['madrix-aura', 8, 0],
    ['garagecube-madmapper5', 43, 17],
    ['garagecube-madmapper6', 50, 17],
    ['resolume-arena', 107, 64],
  ])('%s has %i actions and %i feedbacks', (id, actions, feedbacks) => {
    const mod = getModule(id);
    expect(mod?.actions.length).toBe(actions);
    expect(mod?.feedbacks.length).toBe(feedbacks);
    expect(mod?.coverage).toBe('complete');
  });

  it('indexes the media modules as full and keeps version data in sync', () => {
    const index = getIndex();
    for (const id of [
      'touch-designer',
      'madrix-aura',
      'garagecube-madmapper5',
      'garagecube-madmapper6',
    ]) {
      const entry = index.modules.find((m) => m.moduleId === id);
      expect(entry?.kind).toBe('full');
    }
  });

  it('finds the modules by product name', () => {
    expect(searchModules('madmapper').map((m) => m.moduleId)).toEqual(
      expect.arrayContaining(['garagecube-madmapper5', 'garagecube-madmapper6']),
    );
    expect(searchModules('madrix')[0]?.moduleId).toBe('madrix-aura');
    expect(searchModules('touch designer')[0]?.moduleId).toBe('touch-designer');
  });

  it('lists MADRIX software and Resolume Wire as devices without a module', () => {
    const devices = listNoModule();
    const madrix = devices.find((n) => n.device.startsWith('MADRIX 5'));
    expect(madrix?.alternatives).toEqual(expect.arrayContaining(['generic-osc', 'generic-artnet']));
    expect(devices.some((n) => n.device === 'Resolume Wire')).toBe(true);
  });

  it('marks entries outside the MadMapper light edition', () => {
    expect(findAction('garagecube-madmapper6', 'master_level')?.availability).toBeUndefined();
    expect(findAction('garagecube-madmapper6', 'engine_speed')?.availability).toMatch(/full/);
    expect(findAction('garagecube-madmapper5', 'auto_play')?.availability).toBeUndefined();
  });

  it('keeps the Resolume triggerClip correction and the effect feedbacks', () => {
    expect(findAction('resolume-arena', 'triggerClip')?.provenance.file).toBe(
      'src/actions/clip/actions/connect-clip.ts',
    );
    expect(findAction('resolume-arena', 'connectClip')).toBeUndefined();
    expect(findFeedback('resolume-arena', 'effectBypassedLayer')?.feedbackType).toBe('boolean');
    expect(findFeedback('resolume-arena', 'effectParameterComposition')?.feedbackType).toBe(
      'advanced',
    );
  });
});

describe('media and pixel modules: validation', () => {
  it('validates TouchDesigner operator_parameter', () => {
    expect(
      validateActionOptions('touch-designer', 'operator_parameter', {
        op_name: lit('level1'),
        parameter: lit('opacity'),
        type: lit('float'),
        value: lit('0.5'),
      }),
    ).toEqual([]);
    const bad = validateActionOptions('touch-designer', 'operator_parameter', {
      type: lit('double'),
    });
    expect(codes(bad)).toContain('invalid-value');
  });

  it('rejects expressions for the 1.x modules and allows them for MadMapper (2.x)', () => {
    expect(
      codes(validateActionOptions('madrix-aura', 'cue', { value: expr('$(local:n)') })),
    ).toContain('expression-not-supported');
    expect(
      validateActionOptions('garagecube-madmapper6', 'cue_play', {
        bank: lit(1),
        method: lit('cell'),
        column: lit('2'),
        row: expr('$(local:row)'),
      }),
    ).toEqual([]);
  });

  it('checks MADRIX Aura ranges and choices', () => {
    expect(
      validateActionOptions('madrix-aura', 'intensity', { mode: lit('set'), value: lit(200) }),
    ).toEqual([]);
    expect(
      codes(
        validateActionOptions('madrix-aura', 'intensity', { mode: lit('set'), value: lit(300) }),
      ),
    ).toContain('out-of-range');
    expect(
      codes(validateActionOptions('madrix-aura', 'group_intensity', { group: lit(1) })),
    ).toContain('invalid-type');
    expect(
      validateActionOptions('madrix-aura', 'group_intensity', {
        group: lit('8'),
        mode: lit('set'),
      }),
    ).toEqual([]);
  });

  it('accepts any column number for MadMapper cue dropdowns (allowCustom)', () => {
    const options = { bank: lit(1), method: lit('cell'), column: lit('20'), row: lit(3) };
    expect(validateActionOptions('garagecube-madmapper6', 'cue_play', options)).toEqual([]);
    expect(
      codes(
        validateActionOptions('garagecube-madmapper6', 'cue_play', {
          ...options,
          row: lit(40),
        }),
      ),
    ).toContain('out-of-range');
  });

  it('knows MadMapper 6 only entries and rejects them for MadMapper 5', () => {
    expect(
      validateActionOptions('garagecube-madmapper6', 'conductor_transport', {
        bank: lit(1),
        command: lit('play'),
      }),
    ).toEqual([]);
    expect(
      codes(validateActionOptions('garagecube-madmapper5', 'conductor_transport', {})),
    ).toEqual(['unknown-action']);
    expect(validateFeedbackOptions('garagecube-madmapper5', 'auto_play', { bank: lit(1) })).toEqual(
      [],
    );
  });

  it('validates a Resolume effect feedback', () => {
    expect(
      validateFeedbackOptions('resolume-arena', 'effectBypassedLayer', {
        effectChoice: lit('__manual__'),
        layer: lit('1'),
        effectIdx: lit('2'),
      }),
    ).toEqual([]);
  });
});
