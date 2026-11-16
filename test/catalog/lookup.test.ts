import { describe, expect, it } from 'vitest';
import {
  findAction,
  findFeedback,
  getModule,
  listModules,
  listUnusable,
  searchModules,
  supportsExpressions,
  validateActionOptions,
} from '../../src/catalog/index.js';

describe('listModules', () => {
  it('returns index entries with the documented fields', () => {
    const atem = listModules().find((m) => m.moduleId === 'bmd-atem');
    expect(atem).toMatchObject({ kind: 'full', repo: 'bitfocus/companion-module-bmd-atem' });
    expect(atem?.baseVersion).toMatch(/2\./);
  });

  it('marks the generic modules as full', () => {
    const entry = listModules().find((m) => m.moduleId === 'generic-osc');
    expect(entry?.kind).toBe('full');
  });

  it('does not expose internal state through the returned array', () => {
    const first = listModules();
    first.pop();
    expect(listModules().length).toBe(first.length + 1);
  });

  it('excludes placeholder repositories from the module list', () => {
    expect(listModules().some((m) => m.moduleId === 'your-module-name')).toBe(false);
    expect(listUnusable().some((u) => u.directory === 'disguise-session')).toBe(true);
  });
});

describe('getModule', () => {
  it('returns full data for a catalogued module', () => {
    const mod = getModule('bmd-videohub');
    expect(mod?.coverage).toBe('complete');
    expect(mod?.actions.length).toBeGreaterThan(10);
  });

  it('returns undefined for unknown modules', () => {
    expect(getModule('does-not-exist')).toBeUndefined();
    expect(getModule('__proto__')).toBeUndefined();
    expect(getModule('toString')).toBeUndefined();
  });

  it('returns the same parsed object on repeated calls', () => {
    expect(getModule('bmd-atem')).toBe(getModule('bmd-atem'));
  });
});

describe('searchModules', () => {
  it('finds a module by id', () => {
    expect(searchModules('hyperdeck')[0]?.moduleId).toBe('bmd-hyperdeck');
  });

  it('finds modules by manufacturer', () => {
    const ids = searchModules('blackmagic').map((m) => m.moduleId);
    expect(ids).toContain('bmd-atem');
    expect(ids).toContain('bmd-videohub');
  });

  it('is case-insensitive and requires all terms', () => {
    expect(searchModules('ATEM').map((m) => m.moduleId)).toContain('bmd-atem');
    expect(searchModules('atem zzzznotfound')).toEqual([]);
  });

  it('returns all modules for a blank query', () => {
    expect(searchModules('   ').length).toBe(listModules().length);
  });

  it('ranks exact id matches first', () => {
    expect(searchModules('resolume-arena')[0]?.moduleId).toBe('resolume-arena');
  });
});

describe('findAction and findFeedback', () => {
  it('finds ATEM program and dskAuto actions', () => {
    expect(findAction('bmd-atem', 'program')?.name).toBe('ME: Set Program input');
    expect(findAction('bmd-atem', 'dskAuto')?.options.map((o) => o.id)).toEqual([
      'downstreamKeyerId',
      'onair',
    ]);
  });

  it('records file and line for an action', () => {
    expect(findAction('bmd-videohub', 'route')?.provenance).toEqual({
      file: 'src/actions.ts',
      line: 207,
    });
  });

  it('finds feedbacks', () => {
    expect(findFeedback('bmd-atem', 'program')?.feedbackType).toBe('boolean');
    expect(findFeedback('bmd-videohub', 'selected_destination')).toBeDefined();
  });

  it('returns undefined for unknown ids', () => {
    expect(findAction('bmd-atem', 'nope')).toBeUndefined();
    expect(findAction('nope', 'program')).toBeUndefined();
    expect(findFeedback('bmd-atem', 'nope')).toBeUndefined();
  });

  it('keeps actions and feedbacks separate', () => {
    expect(findAction('bmd-atem', 'macroRecording')).toBeUndefined();
    expect(findFeedback('bmd-atem', 'macroRecording')).toBeDefined();
  });

  it('catalogues Companion core actions under the internal module', () => {
    expect(findAction('internal', 'button_press')?.provenance.file).toBe(
      'companion/lib/Internal/Controls.ts',
    );
  });
});

describe('supportsExpressions', () => {
  it('derives support from the base library major version', () => {
    expect(supportsExpressions({ baseVersion: '~2.1.3' })).toBe(true);
    expect(supportsExpressions({ baseVersion: '^2.0.0' })).toBe(true);
    expect(supportsExpressions({ baseVersion: '~1.12.1' })).toBe(false);
    expect(supportsExpressions({ baseVersion: 'unknown' })).toBe(false);
  });

  it('prefers explicit flags, entity before module', () => {
    expect(supportsExpressions({ baseVersion: '1.0.0', optionsSupportExpressions: true })).toBe(
      true,
    );
    expect(
      supportsExpressions(
        { baseVersion: '2.0.0', optionsSupportExpressions: true },
        { optionsSupportExpressions: false },
      ),
    ).toBe(false);
  });

  it('matches the catalogued modules', () => {
    const atem = getModule('bmd-atem');
    const panasonic = getModule('panasonic-ptz');
    expect(atem && supportsExpressions(atem)).toBe(true);
    expect(panasonic && supportsExpressions(panasonic)).toBe(false);
  });
});

describe('lighting console modules', () => {
  it('finds the module ids by product name', () => {
    const ids = (q: string) => searchModules(q).map((m) => m.moduleId);
    expect(ids('grandma')).toEqual(['malighting-grandma2', 'malighting-grandma3']);
    expect(ids('magicq')).toEqual(['chamsys-magicq-osc', 'chamsys-magicq-udp']);
  });

  it('knows the registered action and feedback ids', () => {
    expect(findAction('malighting-grandma2', 'encoder_p')?.provenance.file).toBe('actions.js');
    expect(findAction('malighting-grandma3', 'exec_button')?.options.map((o) => o.id)).toEqual([
      'page',
      'current_page',
      'button_number',
      'button_state',
    ]);
    expect(findFeedback('malighting-grandma3', 'sequence_active')?.feedbackType).toBe('boolean');
    expect(findAction('chamsys-magicq-udp', 'pbJump')?.options).toHaveLength(3);
    expect(findFeedback('chamsys-magicq-osc', 'dbo')?.options).toEqual([]);
  });

  it('applies expression support from the base library version', () => {
    const osc = getModule('chamsys-magicq-osc');
    const udp = getModule('chamsys-magicq-udp');
    const expr = { pbId: { isExpression: true, value: '1 + 1' } };
    expect(osc && supportsExpressions(osc)).toBe(true);
    expect(udp && supportsExpressions(udp)).toBe(false);
    expect(validateActionOptions('chamsys-magicq-osc', 'pbGo', expr)).toEqual([]);
    expect(validateActionOptions('chamsys-magicq-udp', 'pbGo', expr).map((i) => i.code)).toEqual([
      'expression-not-supported',
    ]);
    const blocked = {
      pbFId: { isExpression: true, value: '1' },
      pbId: { isExpression: false, value: '1' },
    };
    expect(
      validateActionOptions('chamsys-magicq-osc', 'pbFlash', blocked).map((i) => i.code),
    ).toEqual(['expression-not-allowed']);
  });

  it('validates grandMA2 button ids with their source types', () => {
    const ok = {
      button: { isExpression: false, value: '11' },
      dir: { isExpression: false, value: 'true' },
    };
    expect(validateActionOptions('malighting-grandma2', 'button', ok)).toEqual([]);
    expect(
      validateActionOptions('malighting-grandma2', 'button', {
        ...ok,
        dir: { isExpression: false, value: 'up' },
      }).map((i) => i.code),
    ).toEqual(['invalid-value']);
  });
});
