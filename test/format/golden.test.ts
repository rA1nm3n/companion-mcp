import { describe, expect, it } from 'vitest';
import {
  ControlSchema,
  ExportFileSchema,
  FILE_VERSION,
  PageExportSchema,
  FullExportSchema,
  buildPageExport,
  validateExport,
} from '../../src/format/index.js';
import { clone, loadFixture } from './helpers/fixtures.js';

/**
 * Golden standard: these files were really imported into Companion 5.1.3 (research/04-headless-test.md) or exported
 * by it. They must pass the schemas and the validator unchanged.
 */
const GOLDEN_PAGES = ['testA-seite-v12', 'testA2-seite-v12-ohne-pinned', 'export-leer'] as const;

describe('golden files (imported into Companion 5.1.3)', () => {
  it('uses format version 12', () => {
    expect(FILE_VERSION).toBe(12);
  });

  for (const name of GOLDEN_PAGES) {
    it(`${name}: passes the page schema`, () => {
      const result = PageExportSchema.safeParse(loadFixture(name));
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    });

    it(`${name}: passes validateExport without errors`, () => {
      const result = validateExport(loadFixture(name));
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it(`${name}: round-trips through the schema unchanged`, () => {
      const original = loadFixture(name);
      const parsed = ExportFileSchema.parse(original);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(original);
    });
  }

  it('export-leer-full (full export of an empty Companion) passes and round-trips', () => {
    const original = loadFixture('export-leer-full');
    expect(FullExportSchema.safeParse(original).success).toBe(true);
    expect(validateExport(original)).toMatchObject({ ok: true, errors: [] });
    expect(JSON.parse(JSON.stringify(ExportFileSchema.parse(original)))).toEqual(original);
  });

  it('the live reference button (read back from Companion) is a valid control', () => {
    const control = loadFixture('referenz-button-config');
    expect(ControlSchema.safeParse(control).success).toBe(true);
    const page = buildPageExport({ name: 'REF', controls: [{ row: 0, column: 0, control }] });
    expect(validateExport(page).errors).toEqual([]);
  });

  it('testA is a page with the measured content', () => {
    const file = loadFixture('testA-seite-v12');
    const button = file.page.controls['0']['0'];
    expect(button.type).toBe('button-layered');
    expect(button.steps['0'].action_sets.down[0].definitionId).toBe('custom_variable_set_value');
    expect(button.feedbacks[0].styleOverrides[0].elementId).toBe('box0');
  });

  it('testC-inst-5: imported fine by Companion, but rejected for the missing updatePolicy (REST v2 500)', () => {
    const file = loadFixture('testC-inst-5-entity-fehlt');
    const result = validateExport(file);
    expect(result.errors.map((e) => e.code)).toEqual(['connection-missing-update-policy']);

    const fixed = clone(file);
    fixed.instances.connTest1.updatePolicy = 'manual';
    expect(validateExport(fixed).errors).toEqual([]);
  });
});
