import { describe, expect, it } from 'vitest';
import {
  findAction,
  findFeedback,
  getModule,
  searchModules,
  supportsExpressions,
  validateActionOptions,
  validateFeedbackOptions,
} from '../../src/catalog/index.js';

const opt = (value: unknown, isExpression = false) => ({ isExpression, value });

describe('showpace-timer catalog entry', () => {
  const mod = getModule('showpace-timer');

  it('is complete and records the inspected commit', () => {
    expect(mod).toMatchObject({
      moduleId: 'showpace-timer',
      repo: 'rA1nm3n/showpace',
      version: '0.2.1',
      baseVersion: '~2.1.3',
      lastCommitSha: '824fddf',
      coverage: 'complete',
    });
    expect(mod?.actions).toHaveLength(32);
    expect(mod?.feedbacks).toHaveLength(13);
    expect(mod?.feedbacks.every((f) => f.feedbackType === 'boolean')).toBe(true);
  });

  it('points every provenance into integrations/companion/src', () => {
    for (const entity of [...(mod?.actions ?? []), ...(mod?.feedbacks ?? [])]) {
      expect(entity.provenance.file).toMatch(
        /^integrations\/companion\/src\/(actions|feedbacks)\.ts$/,
      );
    }
  });

  it('is found by search and supports expressions (base 2.x)', () => {
    expect(searchModules('showpace').map((m) => m.moduleId)).toEqual(['showpace-timer']);
    expect(mod && supportsExpressions(mod)).toBe(true);
  });

  it('validates action options', () => {
    expect(findAction('showpace-timer', 'tempo_set')).toBeDefined();
    expect(validateActionOptions('showpace-timer', 'tempo_set', { pct: opt(110) })).toEqual([]);
    expect(
      validateActionOptions('showpace-timer', 'tempo_set', { pct: opt(201) }).map((i) => i.code),
    ).toEqual(['out-of-range']);
    expect(
      validateActionOptions('showpace-timer', 'timer_set', {
        minutes: opt(5),
        seconds: opt(60),
      }).map((i) => i.code),
    ).toEqual(['out-of-range']);
    expect(
      validateActionOptions('showpace-timer', 'pres_source', {
        bus: opt('pgm'),
        source: opt('camera'),
      }).map((i) => i.code),
    ).toEqual(['invalid-value']);
    expect(
      validateActionOptions('showpace-timer', 'timer_start', { bogus: opt(1) }).map((i) => i.code),
    ).toEqual(['unknown-option']);
  });

  it('validates feedback options', () => {
    expect(findFeedback('showpace-timer', 'phase')).toBeDefined();
    expect(validateFeedbackOptions('showpace-timer', 'phase', { phase: opt('overtime') })).toEqual(
      [],
    );
    expect(
      validateFeedbackOptions('showpace-timer', 'phase', { phase: opt('blue') }).map((i) => i.code),
    ).toEqual(['invalid-value']);
  });
});
