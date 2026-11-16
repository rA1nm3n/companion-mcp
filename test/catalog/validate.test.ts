import { describe, expect, it } from 'vitest';
import {
  findAction,
  validateActionOptions,
  validateFeedbackOptions,
  type OptionValues,
} from '../../src/catalog/index.js';

const lit = (value: unknown) => ({ isExpression: false, value });
const expr = (value: unknown) => ({ isExpression: true, value });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('validateActionOptions: ATEM', () => {
  it('accepts a valid program action', () => {
    const options: OptionValues = { mixeffect: lit(1), input: lit(3010) };
    expect(validateActionOptions('bmd-atem', 'program', options)).toEqual([]);
  });

  it('accepts dskAuto with downstreamKeyerId', () => {
    const options: OptionValues = { downstreamKeyerId: lit(1), onair: lit('toggle') };
    expect(validateActionOptions('bmd-atem', 'dskAuto', options)).toEqual([]);
  });

  it('rejects dskAuto with key instead of downstreamKeyerId', () => {
    const issues = validateActionOptions('bmd-atem', 'dskAuto', {
      key: lit(1),
      onair: lit('toggle'),
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'options.key', code: 'unknown-option' }),
    );
    // downstreamKeyerId has a default (1), so it is not reported as missing.
    expect(codes(issues)).toEqual(['unknown-option']);
  });

  it('keeps using key for the other DSK actions', () => {
    expect(
      validateActionOptions('bmd-atem', 'dskOnAir', { key: lit(1), onair: lit('true') }),
    ).toEqual([]);
  });

  it('reports a value outside a closed choice list', () => {
    const issues = validateActionOptions('bmd-atem', 'dskOnAir', {
      key: lit(1),
      onair: lit('maybe'),
    });
    expect(codes(issues)).toEqual(['invalid-value']);
    expect(issues[0]?.path).toBe('options.onair');
  });

  it('reports a string where the module uses numeric ids', () => {
    const issues = validateActionOptions('bmd-atem', 'program', {
      mixeffect: lit('1'),
      input: lit(1),
    });
    expect(codes(issues)).toEqual(['invalid-type']);
  });

  it('allows expressions on source pickers (allowInvalidValues, base 2.x)', () => {
    const issues = validateActionOptions('bmd-atem', 'program', {
      mixeffect: lit(1),
      input: expr('$(custom:next_input)'),
    });
    expect(issues).toEqual([]);
  });

  it('rejects expressions on dropdowns with disableAutoExpression', () => {
    const issues = validateActionOptions('bmd-atem', 'dskOnAir', {
      key: lit(1),
      onair: expr('1 == 1'),
    });
    expect(codes(issues)).toEqual(['expression-not-allowed']);
  });

  it('checks number ranges', () => {
    const issues = validateActionOptions('bmd-atem', 'tBar', {
      mixeffect: lit(1),
      position: lit(150),
      fadeDuration: lit(0),
      fadeAlgorithm: lit('linear'),
      fadeCurve: lit('ease-in'),
    });
    expect(issues).toEqual([
      expect.objectContaining({ path: 'options.position', code: 'out-of-range' }),
    ]);
  });

  it('rejects a non-numeric source id', () => {
    const issues = validateActionOptions('bmd-atem', 'program', {
      mixeffect: lit(1),
      input: lit('cam1'),
    });
    expect(codes(issues)).toEqual(['invalid-type']);
  });
});

describe('validateActionOptions: Videohub', () => {
  it('accepts 1-based numeric ports', () => {
    const options: OptionValues = { source: lit(1), destination: lit(12), ignore_lock: lit(false) };
    expect(validateActionOptions('bmd-videohub', 'route', options)).toEqual([]);
  });

  it('rejects a 0-based port number', () => {
    const issues = validateActionOptions('bmd-videohub', 'route', {
      source: lit(0),
      destination: lit(1),
      ignore_lock: lit(false),
    });
    expect(issues).toEqual([
      expect.objectContaining({ path: 'options.source', code: 'out-of-range' }),
    ]);
  });

  it('rejects ports passed as strings', () => {
    const issues = validateActionOptions('bmd-videohub', 'route', {
      source: lit('1'),
      destination: lit(1),
      ignore_lock: lit(false),
    });
    expect(codes(issues)).toEqual(['invalid-type']);
  });

  it('rejects a non-boolean checkbox value', () => {
    const issues = validateActionOptions('bmd-videohub', 'route', {
      source: lit(1),
      destination: lit(1),
      ignore_lock: lit('yes'),
    });
    expect(codes(issues)).toEqual(['invalid-type']);
  });

  it('validates feedbacks the same way', () => {
    expect(
      validateFeedbackOptions('bmd-videohub', 'selected_destination', { output: lit(2) }),
    ).toEqual([]);
    expect(
      codes(validateFeedbackOptions('bmd-videohub', 'selected_destination', { output: lit(0) })),
    ).toEqual(['out-of-range']);
  });
});

describe('validateActionOptions: expressions per base library', () => {
  it('rejects expressions for modules built on base 1.x', () => {
    const issues = validateActionOptions('shure-wireless', 'channel_mute', {
      channel: expr('1'),
      choice: lit('ON'),
    });
    expect(codes(issues)).toEqual(['expression-not-supported']);
  });

  it('accepts expressions for modules built on base 2.x', () => {
    const issues = validateActionOptions('bmd-hyperdeck', 'play', {
      speed: expr('$(local:speed) * 2'),
      loop: lit(false),
      single: lit(false),
    });
    expect(issues).toEqual([]);
  });

  it('honours the per-action flag of internal actions', () => {
    const accepted = validateActionOptions('internal', 'button_press', {
      location: expr("'1/0/0'"),
      force: lit(false),
    });
    expect(accepted).toEqual([]);
    const refused = validateActionOptions('internal', 'trigger_enabled', {
      trigger_id: expr('abc'),
      enable: lit('true'),
    });
    expect(codes(refused)).toContain('expression-not-supported');
  });

  it('requires an expression to be a string', () => {
    const issues = validateActionOptions('bmd-hyperdeck', 'play', {
      speed: expr(5),
      loop: lit(false),
      single: lit(false),
    });
    expect(codes(issues)).toEqual(['invalid-type']);
  });
});

describe('validateActionOptions: general behaviour', () => {
  it('reports unknown modules and actions', () => {
    expect(codes(validateActionOptions('nope', 'x', {}))).toEqual(['unknown-module']);
    expect(codes(validateActionOptions('bmd-atem', 'nope', {}))).toEqual(['unknown-action']);
    expect(codes(validateFeedbackOptions('bmd-atem', 'nope', {}))).toEqual(['unknown-feedback']);
    expect(codes(validateFeedbackOptions('nope', 'x', {}))).toEqual(['unknown-module']);
  });

  it('reports index-only modules as unknown for validation', () => {
    expect(codes(validateActionOptions('generic-osc', 'x', {}))).toEqual(['unknown-module']);
  });

  it('rejects options that are not in { isExpression, value } format', () => {
    expect(codes(validateActionOptions('bmd-atem', 'cut', null))).toEqual(['invalid-option-shape']);
    expect(codes(validateActionOptions('bmd-atem', 'cut', []))).toEqual(['invalid-option-shape']);
    const issues = validateActionOptions('bmd-atem', 'cut', { mixeffect: 1 });
    expect(codes(issues)).toEqual(['invalid-option-shape']);
    const noValue = validateActionOptions('bmd-atem', 'cut', {
      mixeffect: { isExpression: false },
    });
    expect(codes(noValue)).toEqual(['invalid-option-shape']);
  });

  it('accepts an action without options', () => {
    expect(validateActionOptions('bmd-atem', 'macrostop', {})).toEqual([]);
  });

  it('does not report unknown options for entries with incomplete option lists', () => {
    const issues = validateActionOptions('analogway-awj', 'devicePositionSize', {
      extraRuntimeOption: lit('x'),
    });
    expect(codes(issues)).not.toContain('unknown-option');
  });

  it('validates multi-select values element by element', () => {
    const issues = validateActionOptions('analogway-awj', 'deviceSelectSource', {
      method: lit('spec'),
      screen: lit('S1'),
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'options.screen', code: 'invalid-type' }),
    );
  });

  it('checks numeric text inputs and allows variables', () => {
    const ok = validateActionOptions('resolume-arena', 'selectLayer', { layer: lit('3') });
    expect(ok).toEqual([]);
    const variable = validateActionOptions('birddog-ptz', 'recallPset', {
      val: lit('$(custom:p)'),
    });
    expect(variable).toEqual([]);
    const bad = validateActionOptions('birddog-ptz', 'recallPset', { val: lit('abc') });
    expect(codes(bad)).toEqual(['invalid-value']);
    const range = validateActionOptions('birddog-ptz', 'recallPset', { val: lit('99') });
    expect(codes(range)).toEqual(['out-of-range']);
  });

  it('reports missing required options', () => {
    const issues = validateActionOptions('shure-wireless', 'channel_setaudiogain', {
      channel: lit('1'),
    });
    expect(issues).toEqual([
      expect.objectContaining({ path: 'options.gain', code: 'missing-option' }),
    ]);
  });

  it('does not require options that have a default', () => {
    expect(validateActionOptions('bmd-videohub', 'route', {})).toEqual([]);
  });

  it('checks value patterns of dynamic lists', () => {
    expect(findAction('analogway-livepremier', 'audioroute')).toBeDefined();
    const bad = validateActionOptions('analogway-livepremier', 'audioroute', {
      out: lit('speaker/1'),
      in: lit(['"sourceType":"none"']),
    });
    expect(bad).toContainEqual(
      expect.objectContaining({ path: 'options.out', code: 'pattern-mismatch' }),
    );
    const good = validateActionOptions('analogway-livepremier', 'audioroute', {
      out: lit('dante/channels/1'),
      in: lit(['"sourceType":"none"']),
    });
    expect(good.filter((i) => i.code === 'pattern-mismatch')).toEqual([]);
  });

  it('treats an empty choice list as a runtime-filled list, not as a closed one', () => {
    const issues = validateActionOptions('analogway-awj', 'deviceAudioRouteBlock', {
      device: lit('1'),
    });
    expect(codes(issues)).not.toContain('invalid-value');
  });
});
