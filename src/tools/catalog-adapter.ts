import {
  findAction,
  findFeedback,
  getModule,
  validateActionOptions,
  validateFeedbackOptions,
} from '../catalog/index.js';
import type { Issue as CatalogIssue } from '../catalog/index.js';
import type { CatalogLookup, Issue } from '../format/index.js';

/**
 * Catalog issue paths are dotted and start at the entity (`options.input`, `options.list[1]`). The validator expects
 * JSON pointers relative to the options object (`/input`, `/list/1`) and prefixes the entity path itself, so the
 * adapter converts them. Without this the reported path would read `.../options/options.input`.
 */
function relativePointer(path: string): string {
  if (!path.startsWith('options.')) return path;
  return '/' + path.slice('options.'.length).replace(/\[(\d+)\]/g, '/$1');
}

function convert(issues: CatalogIssue[]): Issue[] {
  return issues.map((issue) => ({ ...issue, path: relativePointer(issue.path) }));
}

export const catalogLookup: CatalogLookup = {
  hasModule: (moduleId) => getModule(moduleId) !== undefined,
  findAction,
  findFeedback,
  validateActionOptions: (moduleId, actionId, options): Issue[] =>
    convert(validateActionOptions(moduleId, actionId, options)),
  validateFeedbackOptions: (moduleId, feedbackId, options): Issue[] =>
    convert(validateFeedbackOptions(moduleId, feedbackId, options)),
};
