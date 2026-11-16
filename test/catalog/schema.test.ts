import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IndexFileSchema,
  ModuleDefSchema,
  getIndex,
  getModule,
  listFullModuleIds,
  listModules,
  listNoModule,
  type ModuleDef,
} from '../../src/catalog/index.js';

const DATA_DIR = new URL('../../src/catalog/data/', import.meta.url);
const dataFiles = readdirSync(DATA_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
const moduleFiles = dataFiles.filter((f) => f !== '_index.json');

const PRIO1 = [
  'bmd-hyperdeck',
  'panasonic-ptz',
  'analogway-awj',
  'analogway-livepremier',
  'barco-eventmaster',
  'shure-wireless',
  'luminex-gigacore',
  'dataton-watchout',
  'dataton-watchout-json',
  'resolume-arena',
];
const REPORT_05 = ['bmd-atem', 'bmd-videohub', 'studiocoast-vmix', 'birddog-ptz'];
const AUDIO = [
  'yamaha-rcp',
  'behringer-x32',
  'allenheath-ahm',
  'allenheath-avantis',
  'allenheath-cq',
  'allenheath-dlive',
  'allenheath-dlive-ilive',
  'allenheath-dt168',
  'allenheath-sq',
];

function load(file: string): unknown {
  return JSON.parse(readFileSync(new URL(file, DATA_DIR), 'utf8'));
}

describe('catalog data files', () => {
  it('has the expected set of module files', () => {
    const ids = moduleFiles.map((f) => f.replace(/\.json$/, ''));
    for (const id of [...PRIO1, ...REPORT_05, ...AUDIO, 'internal']) expect(ids).toContain(id);
  });

  it.each(moduleFiles)('%s matches the module schema', (file) => {
    const parsed = ModuleDefSchema.safeParse(load(file));
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3)),
    ).toBe(true);
  });

  it('_index.json matches the index schema', () => {
    expect(IndexFileSchema.safeParse(load('_index.json')).success).toBe(true);
  });

  it.each(moduleFiles)('%s file name equals the module id', (file) => {
    const mod = ModuleDefSchema.parse(load(file));
    expect(mod.moduleId).toBe(file.replace(/\.json$/, ''));
  });
});

describe('catalog consistency', () => {
  const modules: ModuleDef[] = listFullModuleIds().map((id) => {
    const mod = getModule(id);
    if (!mod) throw new Error(`module ${id} not loadable`);
    return mod;
  });

  it('registers every data file in the loader and vice versa', () => {
    expect(listFullModuleIds()).toEqual(moduleFiles.map((f) => f.replace(/\.json$/, '')).sort());
  });

  it('marks exactly the modules with data as full in the index', () => {
    const full = listModules()
      .filter((m) => m.kind === 'full')
      .map((m) => m.moduleId)
      .sort();
    expect(full).toEqual(listFullModuleIds());
  });

  it('has unique module ids in the index', () => {
    const ids = listModules().map((m) => m.moduleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists about 100 modules in the index', () => {
    expect(listModules().length).toBeGreaterThanOrEqual(105);
  });

  it('keeps index metadata in sync with the module data', () => {
    for (const mod of modules) {
      const entry = listModules().find((m) => m.moduleId === mod.moduleId);
      expect(entry, mod.moduleId).toBeDefined();
      expect(entry?.repo, mod.moduleId).toBe(mod.repo);
      expect(entry?.version, mod.moduleId).toBe(mod.version);
      expect(entry?.baseVersion, mod.moduleId).toBe(mod.baseVersion);
      expect(entry?.lastCommit, mod.moduleId).toBe(mod.lastCommit);
    }
  });

  it.each(listFullModuleIds())('%s has no duplicate action or feedback ids', (id) => {
    const mod = getModule(id);
    const actionIds = mod?.actions.map((a) => a.id) ?? [];
    const feedbackIds = mod?.feedbacks.map((f) => f.id) ?? [];
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(new Set(feedbackIds).size).toBe(feedbackIds.length);
  });

  it.each(listFullModuleIds())('%s has no duplicate option ids within an entry', (id) => {
    const mod = getModule(id);
    for (const e of [...(mod?.actions ?? []), ...(mod?.feedbacks ?? [])]) {
      const ids = e.options.map((o) => o.id);
      // Several mutually exclusive options may share an id only when they carry a visibility condition.
      const dups = ids.filter((x, i) => ids.indexOf(x) !== i);
      expect(dups, `${id}/${e.id}`).toEqual([]);
    }
  });

  it.each(listFullModuleIds())('%s has provenance on every action and feedback', (id) => {
    const mod = getModule(id);
    for (const e of [...(mod?.actions ?? []), ...(mod?.feedbacks ?? [])]) {
      expect(e.provenance.file.length, `${id}/${e.id}`).toBeGreaterThan(0);
      expect(e.provenance.line, `${id}/${e.id}`).toBeGreaterThan(0);
      expect(e.provenance.file.startsWith('/'), `${id}/${e.id}`).toBe(false);
    }
  });

  it.each(listFullModuleIds())('%s has source metadata (repo, commit, status)', (id) => {
    const mod = getModule(id);
    expect(mod?.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(mod?.lastCommit).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['verified-sample', 'read', 'unverified']).toContain(mod?.status);
  });

  it.each(PRIO1)('%s has at least 5 actions', (id) => {
    expect(getModule(id)?.actions.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('keeps closed choice lists free of duplicate ids', () => {
    for (const mod of modules) {
      for (const e of [...mod.actions, ...mod.feedbacks]) {
        for (const o of e.options) {
          if (!o.choices) continue;
          const ids = o.choices.map((c) => `${typeof c.id}:${String(c.id)}`);
          expect(new Set(ids).size, `${mod.moduleId}/${e.id}/${o.id}`).toBe(ids.length);
        }
      }
    }
  });

  it('has defaults that are valid choices where a closed list is given', () => {
    // Known inconsistencies in the module sources (default 0 vs choice id '0'); the catalog records
    // the source as written. Any new type mismatch must be reviewed and added here deliberately.
    const knownSourceMismatches = new Set([
      'panasonic-ptz/insPosition/position',
      'panasonic-ptz/colorBarsType/type',
      'studiocoast-vmix/dynamic/number',
    ]);
    const found = new Set<string>();
    for (const mod of modules) {
      for (const e of [...mod.actions, ...mod.feedbacks]) {
        for (const o of e.options) {
          if (o.type !== 'dropdown' || !o.choices || o.default === undefined) continue;
          if (o.allowInvalidValues || o.allowCustom || o.choices.length === 0) continue;
          if (o.choices.some((c) => c.id === o.default)) continue;
          if (o.choices.some((c) => String(c.id) === String(o.default))) {
            found.add(`${mod.moduleId}/${e.id}/${o.id}`);
          }
        }
      }
    }
    expect([...found].sort()).toEqual([...knownSourceMismatches].sort());
  });

  it('uses only declared index kinds and keeps noModule alternatives resolvable', () => {
    const ids = new Set(listModules().map((m) => m.moduleId));
    expect(listNoModule().length).toBeGreaterThan(0);
    for (const n of listNoModule()) {
      expect(n.alternatives.length).toBeGreaterThan(0);
      for (const a of n.alternatives) expect(ids.has(a), `${n.device}: ${a}`).toBe(true);
    }
    const generic = new Set(listNoModule().flatMap((n) => n.alternatives));
    for (const g of ['generic-osc', 'generic-tcp-udp', 'generic-http', 'generic-pjlink']) {
      expect(generic.has(g), g).toBe(true);
    }
    expect(getIndex().unusable.length).toBeGreaterThan(0);
  });
});
