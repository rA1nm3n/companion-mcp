import { describe, expect, it } from 'vitest';
import {
  findAction,
  getIndex,
  getModule,
  listNoModule,
  searchModules,
  validateActionOptions,
  validateFeedbackOptions,
  type OptionValues,
} from '../../src/catalog/index.js';

const lit = (value: unknown) => ({ isExpression: false, value });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('audio console modules', () => {
  it('lists every Allen & Heath module of the bitfocus organisation as full or unusable', () => {
    const ah = searchModules('allenheath').map((m) => m.moduleId);
    expect(ah).toEqual(
      expect.arrayContaining([
        'allenheath-ahm',
        'allenheath-avantis',
        'allenheath-cq',
        'allenheath-dlive',
        'allenheath-dlive-ilive',
        'allenheath-dt168',
        'allenheath-sq',
      ]),
    );
    for (const id of ah) expect(getModule(id), id).toBeDefined();
    expect(getIndex().unusable.map((u) => u.directory)).toContain('allenheath-qu');
  });

  it('records which Yamaha module covers which console series', () => {
    const entry = searchModules('yamaha').find((m) => m.moduleId === 'yamaha-rcp');
    expect(entry?.kind).toBe('full');
    expect(entry?.products).toEqual(expect.arrayContaining(['CL', 'QL', 'TF', 'DM3', 'DM7']));
    expect(entry?.note).toMatch(/yamaha-scp/);
    expect(getIndex().unusable.map((u) => u.directory)).toContain('yamaha-dm');
  });

  it('offers generic alternatives for A&H series without a usable module', () => {
    const devices = listNoModule().filter((n) => n.device.startsWith('Allen & Heath'));
    expect(devices.map((d) => d.device).join(' ')).toMatch(/Qu series/);
    expect(devices.map((d) => d.device).join(' ')).toMatch(/GLD/);
  });

  it('keeps the module-specific caveats in the notes', () => {
    expect(getModule('allenheath-dlive')?.notes?.join(' ')).toMatch(/legacy/i);
    expect(getModule('allenheath-sq')?.notes?.join(' ')).toMatch(/gutted/);
    expect(getModule('yamaha-rcp')?.notes?.join(' ')).toMatch(/schemas/);
  });

  it('has a plausible number of generated Yamaha and X32 entries', () => {
    expect(getModule('yamaha-rcp')?.actions.length).toBeGreaterThan(300);
    expect(getModule('behringer-x32')?.actions.length).toBeGreaterThanOrEqual(100);
  });
});

describe('allowCustom dropdowns (Avantis mute)', () => {
  const base = { channel: lit(0) };
  it('accepts a listed choice', () => {
    expect(
      validateActionOptions('allenheath-avantis', 'mute_input', { ...base, mute: lit('toggle') }),
    ).toEqual([]);
  });
  it('accepts an unlisted value that matches the pattern', () => {
    expect(
      validateActionOptions('allenheath-avantis', 'mute_input', { ...base, mute: lit('true') }),
    ).toEqual([]);
  });
  it('rejects an unlisted value that does not match the pattern', () => {
    const issues = validateActionOptions('allenheath-avantis', 'mute_input', {
      ...base,
      mute: lit('maybe'),
    });
    expect(codes(issues)).toEqual(['pattern-mismatch']);
  });
});

describe('closed lists and ranges', () => {
  it('rejects an unknown SQ mute status and an out-of-range strip', () => {
    const bad: OptionValues = { n: lit(49), status: lit('maybe') };
    expect(codes(validateActionOptions('allenheath-sq', 'mute_input', bad)).sort()).toEqual([
      'invalid-value',
      'out-of-range',
    ]);
    expect(
      validateActionOptions('allenheath-sq', 'mute_input', { n: lit(48), status: lit('on') }),
    ).toEqual([]);
  });

  it('accepts the LR choice for SQ mix selections', () => {
    const ok: OptionValues = { source: lit(1), sink: lit('LR'), leveldb: lit(-10), fade: lit(0) };
    expect(validateActionOptions('allenheath-sq', 'chlev_to_mix', ok)).toEqual([]);
  });

  it('keeps the SQ feedback ids in sync with the mute actions', () => {
    const feedback = validateFeedbackOptions('allenheath-sq', 'mute_aux', { n: lit(12) });
    expect(feedback).toEqual([]);
    expect(findAction('allenheath-sq', 'mute_aux')?.options.map((o) => o.id)).toEqual([
      'n',
      'status',
    ]);
  });

  it('validates the dLive channel selection by type', () => {
    const action = findAction('allenheath-dlive', 'mute');
    expect(action?.options.map((o) => o.id)).toContain('channelType');
    const bad = validateActionOptions('allenheath-dlive', 'mute', {
      channelType: lit('input'),
      input: lit(500),
      mute: lit(true),
    });
    expect(codes(bad)).toContain('out-of-range');
  });

  it('allows loose X32 targets (allowInvalidValues)', () => {
    const action = findAction('behringer-x32', 'mute');
    const target = action?.options.find((o) => o.type === 'dropdown' && o.allowInvalidValues);
    expect(target).toBeDefined();
  });
});
