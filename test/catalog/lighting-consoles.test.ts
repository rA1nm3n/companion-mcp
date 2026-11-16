import { describe, expect, it } from 'vitest';
import {
  findAction,
  findFeedback,
  getModule,
  listNoModule,
  searchModules,
  supportsExpressions,
  validateActionOptions,
  validateFeedbackOptions,
} from '../../src/catalog/index.js';

const lit = (value: unknown) => ({ isExpression: false, value });
const expr = (value: unknown) => ({ isExpression: true, value });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('lighting console modules', () => {
  it.each([
    ['highend-hog4', 10, 0],
    ['avolites-titan', 55, 4],
    ['etc-eos', 15, 5],
    ['obsidiancontrol-onyx', 11, 1],
    ['obsidiancontrol-onyx-osc', 5, 2],
  ])('%s has the counted number of actions and feedbacks', (id, actions, feedbacks) => {
    const mod = getModule(id);
    expect(mod?.coverage).toBe('complete');
    expect(mod?.actions).toHaveLength(actions);
    expect(mod?.feedbacks).toHaveLength(feedbacks);
  });

  it('is found by manufacturer and product searches', () => {
    expect(searchModules('hog 4').map((m) => m.moduleId)).toContain('highend-hog4');
    expect(searchModules('avolites').map((m) => m.moduleId)).toContain('avolites-titan');
    expect(searchModules('eos').map((m) => m.moduleId)).toContain('etc-eos');
    const onyx = searchModules('onyx').map((m) => m.moduleId);
    expect(onyx).toEqual(
      expect.arrayContaining(['obsidiancontrol-onyx', 'obsidiancontrol-onyx-osc']),
    );
  });

  it('does not support expressions (all five modules are built on base 1.x)', () => {
    for (const id of [
      'highend-hog4',
      'avolites-titan',
      'etc-eos',
      'obsidiancontrol-onyx',
      'obsidiancontrol-onyx-osc',
    ]) {
      const mod = getModule(id);
      expect(mod && supportsExpressions(mod), id).toBe(false);
    }
  });
});

describe('Hog 4', () => {
  it('validates a cuelist go and rejects a bad playback type', () => {
    expect(
      validateActionOptions('highend-hog4', 'go', {
        type: lit('0'),
        num: lit(3),
        action: lit('1'),
      }),
    ).toEqual([]);
    expect(
      codes(
        validateActionOptions('highend-hog4', 'go', {
          type: lit('9'),
          num: lit(3),
          action: lit('1'),
        }),
      ),
    ).toEqual(['invalid-value']);
  });

  it('keeps the master number range 0-90', () => {
    expect(
      codes(validateActionOptions('highend-hog4', 'masterFader', { mId: lit(91), level: lit(10) })),
    ).toEqual(['out-of-range']);
  });
});

describe('Avolites Titan', () => {
  it('knows handle based actions with the handle mode choices', () => {
    const action = findAction('avolites-titan', 'cuelistCut');
    expect(action?.options.map((o) => o.id)).toEqual(['handleMode', 'handle']);
    expect(
      validateActionOptions('avolites-titan', 'cuelistCut', {
        handleMode: lit('userNumber'),
        handle: lit('12'),
      }),
    ).toEqual([]);
    expect(
      codes(
        validateActionOptions('avolites-titan', 'cuelistCut', {
          handleMode: lit('name'),
          handle: lit('12'),
        }),
      ),
    ).toEqual(['invalid-value']);
  });

  it('records the generated boolean feedbacks and the advanced image feedback', () => {
    expect(findFeedback('avolites-titan', 'blackout')?.feedbackType).toBe('boolean');
    expect(findFeedback('avolites-titan', 'image')?.feedbackType).toBe('advanced');
    expect(validateFeedbackOptions('avolites-titan', 'blind', { active: lit(true) })).toEqual([]);
  });

  it('rejects expressions on a base 1.x module', () => {
    expect(
      codes(validateActionOptions('avolites-titan', 'recallMacro', { un: expr('$(a:b)') })),
    ).toEqual(['expression-not-supported']);
  });
});

describe('ETC Eos', () => {
  it('uses text inputs for cue list and cue number', () => {
    const action = findAction('etc-eos', 'run_cue');
    expect(action?.options.map((o) => [o.id, o.type])).toEqual([
      ['list', 'textinput'],
      ['number', 'textinput'],
    ]);
    expect(
      validateActionOptions('etc-eos', 'run_cue', { list: lit('1'), number: lit('2.5') }),
    ).toEqual([]);
  });

  it('does not record a pattern for the macro feedback (Regex.INT is undefined in base 1.15.0)', () => {
    const fb = findFeedback('etc-eos', 'macroisfired');
    expect(fb?.options[0]?.regex).toBeUndefined();
  });
});

describe('ONYX', () => {
  it('lists the button names of the OSC module as a closed list', () => {
    const action = findAction('obsidiancontrol-onyx-osc', 'generic_button');
    const button = action?.options.find((o) => o.id === 'button');
    expect(button?.choices?.length).toBe(123);
    expect(button?.choices?.some((c) => c.id === 'GO')).toBe(true);
    const led = findFeedback('obsidiancontrol-onyx-osc', 'generic_button_led')?.options[0];
    expect(led?.choices?.length).toBe(94);
  });

  it('keeps the telnet and OSC action sets separate', () => {
    expect(findAction('obsidiancontrol-onyx', 'goCuelist')).toBeDefined();
    expect(findAction('obsidiancontrol-onyx-osc', 'goCuelist')).toBeUndefined();
    expect(findAction('obsidiancontrol-onyx-osc', 'playback_level')).toBeDefined();
  });
});

describe('Infinity Chimp', () => {
  it('is listed as a device without a module, with no unverified alternative', () => {
    const entry = listNoModule().find((n) => n.device.includes('Infinity Chimp'));
    expect(entry).toBeDefined();
    expect(entry?.alternatives).toEqual([]);
    expect(entry?.note).toBeTruthy();
  });
});
