import type { CatalogLookup, Issue } from '../../../src/format/validate.js';

/**
 * Minimal catalog for tests, built from research note 05 (module source of bmd-atem, bmd-videohub,
 * studiocoast-vmix, birddog-ptz). It checks that option ids are known and that all required options are present,
 * so the templates are verified against the documented option names.
 */
interface Definition {
  options: string[];
  /** Options that may be omitted. */
  optional?: string[];
}

const ACTIONS: Record<string, Record<string, Definition>> = {
  'bmd-atem': {
    program: { options: ['mixeffect', 'input'] },
    preview: { options: ['mixeffect', 'input'] },
    cut: { options: ['mixeffect'] },
    auto: { options: ['mixeffect'] },
  },
  'bmd-videohub': {
    route: { options: ['source', 'destination', 'ignore_lock'] },
  },
  'studiocoast-vmix': {
    previewInput: { options: ['input', 'mix'] },
    programCut: { options: ['input', 'mix'] },
  },
  'birddog-ptz': {
    recallPset: { options: ['val'] },
  },
};

const FEEDBACKS: Record<string, Record<string, Definition>> = {
  'bmd-atem': {
    program: { options: ['mixeffect', 'input'] },
    preview: { options: ['mixeffect', 'input'] },
  },
  'bmd-videohub': {
    input_bg: { options: ['input', 'output'] },
  },
  'studiocoast-vmix': {
    inputPreview: { options: ['input', 'mix', 'fg', 'bg', 'tally'] },
    inputLive: { options: ['input', 'mix', 'fg', 'bg', 'tally'] },
  },
};

function check(definition: Definition, options: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  for (const key of Object.keys(options)) {
    if (!definition.options.includes(key)) {
      issues.push({ path: `/${key}`, code: 'unknown-option', message: `Unknown option "${key}"` });
    }
  }
  for (const key of definition.options) {
    if (!(key in options) && !definition.optional?.includes(key)) {
      issues.push({
        path: `/${key}`,
        code: 'missing-option',
        message: `Option "${key}" is required`,
      });
    }
  }
  return issues;
}

export const testCatalog: CatalogLookup = {
  hasModule: (moduleId) => moduleId in ACTIONS,
  findAction: (moduleId, actionId) => ACTIONS[moduleId]?.[actionId],
  findFeedback: (moduleId, feedbackId) => FEEDBACKS[moduleId]?.[feedbackId],
  validateActionOptions: (moduleId, actionId, options) => {
    const definition = ACTIONS[moduleId]?.[actionId];
    return definition ? check(definition, options) : [];
  },
  validateFeedbackOptions: (moduleId, feedbackId, options) => {
    const definition = FEEDBACKS[moduleId]?.[feedbackId];
    return definition ? check(definition, options) : [];
  },
};
