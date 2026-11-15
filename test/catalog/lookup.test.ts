import { describe, expect, it } from 'vitest';
import {
  findAction,
  findFeedback,
  getModule,
  listModules,
  listUnusable,
  searchModules,
  supportsExpressions,
} from '../../src/catalog/index.js';

describe('listModules', () => {
  it('returns index entries with the documented fields', () => {
    const atem = listModules().find((m) => m.moduleId === 'bmd-atem');
    expect(atem).toMatchObject({ kind: 'full', repo: 'bitfocus/companion-module-bmd-atem' });
    expect(atem?.baseVersion).toMatch(/2\./);
  });

  it('marks modules without catalog data as index-only', () => {
    const entry = listModules().find((m) => m.moduleId === 'generic-osc');
    expect(entry?.kind).toBe('index-only');
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

  it('returns undefined for unknown and index-only modules', () => {
    expect(getModule('does-not-exist')).toBeUndefined();
    expect(getModule('generic-osc')).toBeUndefined();
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
