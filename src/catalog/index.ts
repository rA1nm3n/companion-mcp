import allenheathAhm from './data/allenheath-ahm.json' with { type: 'json' };
import allenheathAvantis from './data/allenheath-avantis.json' with { type: 'json' };
import allenheathCq from './data/allenheath-cq.json' with { type: 'json' };
import allenheathDlive from './data/allenheath-dlive.json' with { type: 'json' };
import allenheathDliveIlive from './data/allenheath-dlive-ilive.json' with { type: 'json' };
import allenheathDt168 from './data/allenheath-dt168.json' with { type: 'json' };
import allenheathSq from './data/allenheath-sq.json' with { type: 'json' };
import analogwayAwj from './data/analogway-awj.json' with { type: 'json' };
import analogwayLivepremier from './data/analogway-livepremier.json' with { type: 'json' };
import avolitesTitan from './data/avolites-titan.json' with { type: 'json' };
import barcoEventmaster from './data/barco-eventmaster.json' with { type: 'json' };
import behringerX32 from './data/behringer-x32.json' with { type: 'json' };
import birddogPtz from './data/birddog-ptz.json' with { type: 'json' };
import bmdAtem from './data/bmd-atem.json' with { type: 'json' };
import bmdHyperdeck from './data/bmd-hyperdeck.json' with { type: 'json' };
import bmdVideohub from './data/bmd-videohub.json' with { type: 'json' };
import chamsysMagicqOsc from './data/chamsys-magicq-osc.json' with { type: 'json' };
import chamsysMagicqUdp from './data/chamsys-magicq-udp.json' with { type: 'json' };
import datatonWatchoutJson from './data/dataton-watchout-json.json' with { type: 'json' };
import datatonWatchout from './data/dataton-watchout.json' with { type: 'json' };
import etcEos from './data/etc-eos.json' with { type: 'json' };
import highendHog4 from './data/highend-hog4.json' with { type: 'json' };
import internal from './data/internal.json' with { type: 'json' };
import luminexGigacore from './data/luminex-gigacore.json' with { type: 'json' };
import malightingGrandma2 from './data/malighting-grandma2.json' with { type: 'json' };
import malightingGrandma3 from './data/malighting-grandma3.json' with { type: 'json' };
import obsidiancontrolOnyx from './data/obsidiancontrol-onyx.json' with { type: 'json' };
import obsidiancontrolOnyxOsc from './data/obsidiancontrol-onyx-osc.json' with { type: 'json' };
import garagecubeMadmapper5 from './data/garagecube-madmapper5.json' with { type: 'json' };
import garagecubeMadmapper6 from './data/garagecube-madmapper6.json' with { type: 'json' };
import internal from './data/internal.json' with { type: 'json' };
import luminexGigacore from './data/luminex-gigacore.json' with { type: 'json' };
import madrixAura from './data/madrix-aura.json' with { type: 'json' };
import panasonicPtz from './data/panasonic-ptz.json' with { type: 'json' };
import resolumeArena from './data/resolume-arena.json' with { type: 'json' };
import shureWireless from './data/shure-wireless.json' with { type: 'json' };
import studiocoastVmix from './data/studiocoast-vmix.json' with { type: 'json' };
import touchDesigner from './data/touch-designer.json' with { type: 'json' };
import yamahaRcp from './data/yamaha-rcp.json' with { type: 'json' };
import indexData from './data/_index.json' with { type: 'json' };
import {
  IndexFileSchema,
  ModuleDefSchema,
  type ActionDef,
  type FeedbackDef,
  type IndexEntry,
  type IndexFile,
  type Issue,
  type ModuleDef,
  type NoModuleEntry,
  type OptionDef,
  type UnusableEntry,
} from './types.js';

export * from './types.js';

/**
 * Raw module data by module id. To add a module: add the JSON file under `data/`, import it above,
 * and add it here (see docs/catalog.md). The consistency test fails when the index and this map
 * disagree.
 */
const RAW_MODULES: Readonly<Record<string, unknown>> = {
  'allenheath-ahm': allenheathAhm,
  'allenheath-avantis': allenheathAvantis,
  'allenheath-cq': allenheathCq,
  'allenheath-dlive': allenheathDlive,
  'allenheath-dlive-ilive': allenheathDliveIlive,
  'allenheath-dt168': allenheathDt168,
  'allenheath-sq': allenheathSq,
  'analogway-awj': analogwayAwj,
  'analogway-livepremier': analogwayLivepremier,
  'avolites-titan': avolitesTitan,
  'barco-eventmaster': barcoEventmaster,
  'behringer-x32': behringerX32,
  'birddog-ptz': birddogPtz,
  'bmd-atem': bmdAtem,
  'bmd-hyperdeck': bmdHyperdeck,
  'bmd-videohub': bmdVideohub,
  'chamsys-magicq-osc': chamsysMagicqOsc,
  'chamsys-magicq-udp': chamsysMagicqUdp,
  'dataton-watchout': datatonWatchout,
  'dataton-watchout-json': datatonWatchoutJson,
  'etc-eos': etcEos,
  'highend-hog4': highendHog4,
  internal,
  'luminex-gigacore': luminexGigacore,
  'malighting-grandma2': malightingGrandma2,
  'malighting-grandma3': malightingGrandma3,
  'obsidiancontrol-onyx': obsidiancontrolOnyx,
  'obsidiancontrol-onyx-osc': obsidiancontrolOnyxOsc,
  'garagecube-madmapper5': garagecubeMadmapper5,
  'garagecube-madmapper6': garagecubeMadmapper6,
  internal,
  'luminex-gigacore': luminexGigacore,
  'madrix-aura': madrixAura,
  'panasonic-ptz': panasonicPtz,
  'resolume-arena': resolumeArena,
  'shure-wireless': shureWireless,
  'studiocoast-vmix': studiocoastVmix,
  'touch-designer': touchDesigner,
  'yamaha-rcp': yamahaRcp,
};

let indexCache: IndexFile | undefined;
const moduleCache = new Map<string, ModuleDef>();

/** The parsed module index (all known modules, devices without a module, unusable repositories). */
export function getIndex(): IndexFile {
  indexCache ??= IndexFileSchema.parse(indexData);
  return indexCache;
}

/** All modules of the index, sorted by module id. */
export function listModules(): IndexEntry[] {
  return [...getIndex().modules];
}

/** Devices without a Companion module, each with generic alternatives. */
export function listNoModule(): NoModuleEntry[] {
  return [...getIndex().noModule];
}

/** Repositories that exist but cannot be used as connection modules. */
export function listUnusable(): UnusableEntry[] {
  return [...getIndex().unusable];
}

/** Module ids that have full catalog data (`kind: 'full'`). */
export function listFullModuleIds(): string[] {
  return Object.keys(RAW_MODULES).sort();
}

/** Full catalog data of one module, or `undefined` if the module has no data (index-only or unknown). */
export function getModule(moduleId: string): ModuleDef | undefined {
  const cached = moduleCache.get(moduleId);
  if (cached) return cached;
  if (!Object.hasOwn(RAW_MODULES, moduleId)) return undefined;
  const parsed = ModuleDefSchema.parse(RAW_MODULES[moduleId]);
  moduleCache.set(moduleId, parsed);
  return parsed;
}

function haystack(entry: IndexEntry): string {
  return [
    entry.moduleId,
    entry.repo,
    entry.manufacturer,
    ...(entry.products ?? []),
    ...(entry.keywords ?? []),
  ]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * Case-insensitive search over module id, repository, manufacturer, products and keywords.
 * Every whitespace-separated term must match. Results are ranked: id matches first, then
 * manufacturer/product matches. A blank query returns all modules.
 */
export function searchModules(query: string): IndexEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return listModules();
  const scored: Array<{ entry: IndexEntry; score: number }> = [];
  for (const entry of getIndex().modules) {
    const hay = haystack(entry);
    const id = entry.moduleId.toLowerCase();
    let score = 0;
    let all = true;
    for (const term of terms) {
      if (!hay.includes(term)) {
        all = false;
        break;
      }
      if (id === term) score += 100;
      else if (id.startsWith(term)) score += 40;
      else if (id.includes(term)) score += 20;
      else if (entry.manufacturer?.toLowerCase().includes(term)) score += 10;
      else score += 5;
    }
    if (all) {
      if (entry.kind === 'full') score += 1;
      scored.push({ entry, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.entry.moduleId.localeCompare(b.entry.moduleId));
  return scored.map((s) => s.entry);
}

/** Action definition by module and action id. */
export function findAction(moduleId: string, actionId: string): ActionDef | undefined {
  return getModule(moduleId)?.actions.find((a) => a.id === actionId);
}

/** Feedback definition by module and feedback id. */
export function findFeedback(moduleId: string, feedbackId: string): FeedbackDef | undefined {
  return getModule(moduleId)?.feedbacks.find((f) => f.id === feedbackId);
}

/**
 * Whether option values of the entity may be expressions. Order: per-entity flag, per-module flag,
 * then the major version of the `@companion-module/base` range (2 and above support expressions;
 * Companion 5.1.3 `doesModuleUseNewChildHandler`). An unreadable range counts as unsupported.
 */
export function supportsExpressions(
  module: Pick<ModuleDef, 'baseVersion' | 'optionsSupportExpressions'>,
  entity?: Pick<ActionDef, 'optionsSupportExpressions'>,
): boolean {
  if (entity?.optionsSupportExpressions !== undefined) return entity.optionsSupportExpressions;
  if (module.optionsSupportExpressions !== undefined) return module.optionsSupportExpressions;
  const major = /(\d+)\./.exec(module.baseVersion)?.[1];
  return major !== undefined && Number(major) >= 2;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value));
}

function checkRange(def: OptionDef, n: number, path: string, issues: Issue[]): void {
  if (def.min !== undefined && n < def.min) {
    issues.push({
      path,
      code: 'out-of-range',
      message: `Value ${n} is below the minimum ${def.min}.`,
    });
  }
  if (def.max !== undefined && n > def.max) {
    issues.push({
      path,
      code: 'out-of-range',
      message: `Value ${n} is above the maximum ${def.max}.`,
    });
  }
}

function checkPattern(def: OptionDef, s: string, path: string, issues: Issue[]): void {
  if (def.valuePattern === undefined) return;
  if (!new RegExp(def.valuePattern).test(s)) {
    issues.push({
      path,
      code: 'pattern-mismatch',
      message: `Value ${describe(s)} does not match the pattern ${def.valuePattern}.`,
    });
  }
}

/** Checks one scalar against a dropdown definition (also used per element of a multidropdown). */
function checkDropdownScalar(def: OptionDef, value: unknown, path: string, issues: Issue[]): void {
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    issues.push({
      path,
      code: 'invalid-type',
      message: `Dropdown value must be a string, number or boolean, got ${describe(value)}.`,
    });
    return;
  }
  const choices = def.choices;
  // An empty list means the module fills the choices at runtime (or hides the field): not closed.
  if (choices !== undefined && choices.length > 0) {
    if (choices.some((c) => c.id === value)) return;
    if (!def.allowInvalidValues && !def.allowCustom) {
      const loose = choices.find((c) => String(c.id) === String(value));
      if (loose) {
        issues.push({
          path,
          code: 'invalid-type',
          message: `Value ${describe(value)} has the wrong type: the module uses ${typeof loose.id} ids, use ${describe(loose.id)}.`,
        });
      } else {
        const shown = choices
          .slice(0, 12)
          .map((c) => describe(c.id))
          .join(', ');
        issues.push({
          path,
          code: 'invalid-value',
          message: `Value ${describe(value)} is not one of the allowed choices (${shown}${choices.length > 12 ? ', ...' : ''}).`,
        });
      }
      return;
    }
  }
  // Dynamic list, allowInvalidValues or allowCustom (free text next to the listed choices): check the
  // declared value shape (type, range, pattern) only.
  switch (def.valueType) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({
          path,
          code: 'invalid-type',
          message: `Value must be a number, got ${describe(value)}.`,
        });
        return;
      }
      if (def.integer && !Number.isInteger(value)) {
        issues.push({ path, code: 'invalid-value', message: `Value ${value} must be an integer.` });
        return;
      }
      checkRange(def, value, path, issues);
      return;
    case 'string':
      if (typeof value !== 'string') {
        issues.push({
          path,
          code: 'invalid-type',
          message: `Value must be a string, got ${describe(value)}.`,
        });
        return;
      }
      checkPattern(def, value, path, issues);
      return;
    case 'numeric': {
      const n =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && NUMERIC.test(value)
            ? Number(value)
            : NaN;
      if (!Number.isFinite(n)) {
        issues.push({
          path,
          code: 'invalid-type',
          message: `Value must be a number or a numeric string, got ${describe(value)}.`,
        });
        return;
      }
      checkRange(def, n, path, issues);
      return;
    }
    default:
      if (typeof value === 'string') checkPattern(def, value, path, issues);
  }
}

function checkLiteral(def: OptionDef, value: unknown, path: string, issues: Issue[]): void {
  switch (def.type) {
    case 'dropdown':
      checkDropdownScalar(def, value, path, issues);
      return;
    case 'multidropdown':
      if (!Array.isArray(value)) {
        issues.push({
          path,
          code: 'invalid-type',
          message: `Multi-select value must be an array, got ${describe(value)}.`,
        });
        return;
      }
      value.forEach((item: unknown, i) => checkDropdownScalar(def, item, `${path}[${i}]`, issues));
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({
          path,
          code: 'invalid-type',
          message: `Value must be a number, got ${describe(value)}.`,
        });
        return;
      }
      if (def.integer && !Number.isInteger(value)) {
        issues.push({ path, code: 'invalid-value', message: `Value ${value} must be an integer.` });
        return;
      }
      checkRange(def, value, path, issues);
      return;
    case 'textinput': {
      if (typeof value !== 'string') {
        issues.push({
          path,
          code: 'invalid-type',
          message: `Value must be a string, got ${describe(value)}.`,
        });
        return;
      }
      const hasVariable = def.useVariables === true && value.includes('$(');
      if (def.valueType !== undefined && def.valueType !== 'string' && !hasVariable) {
        if (!NUMERIC.test(value.trim())) {
          issues.push({
            path,
            code: 'invalid-value',
            message: `Value ${describe(value)} must be numeric.`,
          });
          return;
        }
        const n = Number(value);
        if (def.integer && !Number.isInteger(n)) {
          issues.push({
            path,
            code: 'invalid-value',
            message: `Value ${value} must be an integer.`,
          });
          return;
        }
        checkRange(def, n, path, issues);
      } else if (!hasVariable) {
        checkPattern(def, value, path, issues);
      }
      return;
    }
    case 'checkbox':
      if (typeof value !== 'boolean') {
        issues.push({
          path,
          code: 'invalid-type',
          message: `Value must be a boolean, got ${describe(value)}.`,
        });
      }
      return;
    case 'colorpicker':
      if (typeof value !== 'number' && typeof value !== 'string') {
        issues.push({
          path,
          code: 'invalid-type',
          message: `Color must be a number or a string, got ${describe(value)}.`,
        });
      }
      return;
    default:
      return;
  }
}

/**
 * An option the caller has to supply: flagged `required`, or a dropdown/number without default that
 * is always shown. Text inputs without default are optional (they start empty).
 */
function isRequired(def: OptionDef): boolean {
  if (def.required === true) return true;
  if (def.required === false) return false;
  return (
    def.default === undefined &&
    def.visibleWhen === undefined &&
    (def.type === 'dropdown' || def.type === 'number' || def.type === 'multidropdown')
  );
}

function validateEntityOptions(
  module: ModuleDef,
  entity: ActionDef | FeedbackDef,
  options: unknown,
): Issue[] {
  const issues: Issue[] = [];
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return [
      {
        path: 'options',
        code: 'invalid-option-shape',
        message: 'Options must be an object of { optionId: { isExpression, value } }.',
      },
    ];
  }
  const given = options as Record<string, unknown>;
  const known = new Map(entity.options.map((o) => [o.id, o]));
  const expressionsOk = supportsExpressions(module, entity);

  if (entity.optionsComplete !== false) {
    for (const id of Object.keys(given)) {
      if (!known.has(id)) {
        issues.push({
          path: `options.${id}`,
          code: 'unknown-option',
          message: `Unknown option '${id}'. Known options: ${[...known.keys()].join(', ') || '(none)'}.`,
        });
      }
    }
  }

  for (const def of entity.options) {
    const path = `options.${def.id}`;
    if (!Object.hasOwn(given, def.id)) {
      if (isRequired(def)) {
        issues.push({
          path,
          code: 'missing-option',
          message: `Required option '${def.id}' is missing.`,
        });
      }
      continue;
    }
    const raw = given[def.id];
    if (
      typeof raw !== 'object' ||
      raw === null ||
      Array.isArray(raw) ||
      typeof (raw as { isExpression?: unknown }).isExpression !== 'boolean' ||
      !('value' in raw)
    ) {
      issues.push({
        path,
        code: 'invalid-option-shape',
        message: `Option '${def.id}' must be { isExpression: boolean, value }.`,
      });
      continue;
    }
    const { isExpression, value } = raw as { isExpression: boolean; value: unknown };
    if (isExpression) {
      if (!expressionsOk) {
        issues.push({
          path,
          code: 'expression-not-supported',
          message: `The ${entity.id} options of module ${module.moduleId} do not support expressions (module built on @companion-module/base ${module.baseVersion}).`,
        });
      } else if (def.disableAutoExpression === true) {
        issues.push({
          path,
          code: 'expression-not-allowed',
          message: `Option '${def.id}' does not allow expressions (disableAutoExpression in the module source).`,
        });
      } else if (typeof value !== 'string') {
        issues.push({
          path,
          code: 'invalid-type',
          message: `An expression must be a string, got ${describe(value)}.`,
        });
      }
      continue;
    }
    checkLiteral(def, value, path, issues);
  }
  return issues;
}

/**
 * Validates action options (Companion 5 entity format `{ optionId: { isExpression, value } }`)
 * against the catalog. Returns an empty array when nothing is wrong. The validation is only as
 * good as the catalog data: dynamic lists (`choicesNote`) are checked for their declared shape,
 * and entries with `optionsComplete: false` do not report unknown options.
 */
export function validateActionOptions(
  moduleId: string,
  actionId: string,
  options: unknown,
): Issue[] {
  const module = getModule(moduleId);
  if (!module) {
    return [
      {
        path: 'moduleId',
        code: 'unknown-module',
        message: `No catalog data for module '${moduleId}'.`,
      },
    ];
  }
  const action = module.actions.find((a) => a.id === actionId);
  if (!action) {
    return [
      {
        path: 'actionId',
        code: 'unknown-action',
        message: `Module '${moduleId}' has no catalogued action '${actionId}'.`,
      },
    ];
  }
  return validateEntityOptions(module, action, options);
}

/** Same as {@link validateActionOptions} for feedbacks. */
export function validateFeedbackOptions(
  moduleId: string,
  feedbackId: string,
  options: unknown,
): Issue[] {
  const module = getModule(moduleId);
  if (!module) {
    return [
      {
        path: 'moduleId',
        code: 'unknown-module',
        message: `No catalog data for module '${moduleId}'.`,
      },
    ];
  }
  const feedback = module.feedbacks.find((f) => f.id === feedbackId);
  if (!feedback) {
    return [
      {
        path: 'feedbackId',
        code: 'unknown-feedback',
        message: `Module '${moduleId}' has no catalogued feedback '${feedbackId}'.`,
      },
    ];
  }
  return validateEntityOptions(module, feedback, options);
}
