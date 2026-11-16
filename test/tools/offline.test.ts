import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness.js';

const EXPECTED_TOOLS = [
  'build_page',
  'catalog_action',
  'catalog_module',
  'catalog_search',
  'export',
  'generate_page',
  'get_page',
  'import_page',
  'list_connections',
  'list_surfaces',
  'press',
  'rollback',
  'satellite_snapshot',
  'status',
  'validate_config',
].map((name) => `companion_${name}`);

let h: Harness;
beforeAll(async () => {
  h = await startHarness({});
});
afterAll(async () => {
  await h.close();
});

describe('tool listing', () => {
  it('lists exactly the expected tools with strict object schemas and descriptions', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations).toBeDefined();
    }
  });

  it('marks read tools read-only and write tools destructive and not idempotent', async () => {
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of EXPECTED_TOOLS) {
      const annotations = byName.get(name)?.annotations;
      if (name.endsWith('import_page') || name.endsWith('rollback') || name.endsWith('press')) {
        expect(annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        });
      } else {
        expect(annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
      }
    }
  });

  it('advertises dry_run with default true on all write tools', async () => {
    const { tools } = await h.client.listTools();
    for (const name of ['companion_import_page', 'companion_rollback', 'companion_press']) {
      const props = tools.find((t) => t.name === name)?.inputSchema.properties as
        Record<string, { default?: unknown }> | undefined;
      expect(props?.['dry_run']?.default).toBe(true);
    }
  });

  it('rejects input that violates the schema at the protocol layer (unknown key, wrong type)', async () => {
    const unknownKey = await h.client.callTool({
      name: 'companion_catalog_search',
      arguments: { query: 'atem', bogus: 1 },
    });
    expect(unknownKey.isError).toBe(true);
    const wrongType = await h.client.callTool({
      name: 'companion_catalog_search',
      arguments: { query: 42 },
    });
    expect(wrongType.isError).toBe(true);
  });
});

describe('catalog tools', () => {
  it('catalog_search finds the ATEM module', async () => {
    const { body, isError } = await h.call('catalog_search', { query: 'blackmagic atem' });
    expect(isError).toBe(false);
    expect(body.ok).toBe(true);
    const modules = body['modules'] as Array<{ moduleId: string }>;
    expect(modules.map((m) => m.moduleId)).toContain('bmd-atem');
  });

  it('catalog_search returns an empty list for nonsense and respects limit', async () => {
    const none = await h.call('catalog_search', { query: 'zzzz-no-such-device' });
    expect(none.body).toMatchObject({ ok: true, total: 0, modules: [] });
    const limited = await h.call('catalog_search', { query: '', limit: 3 });
    expect((limited.body['modules'] as unknown[]).length).toBe(3);
    expect(limited.body['total'] as number).toBeGreaterThan(3);
  });

  it('catalog_module returns actions of a full module, an index entry, and a failure with suggestions', async () => {
    const full = await h.call('catalog_module', { moduleId: 'bmd-atem' });
    expect(full.body).toMatchObject({ ok: true, kind: 'full', moduleId: 'bmd-atem' });
    expect((full.body['actions'] as Array<{ id: string }>).map((a) => a.id)).toContain('program');

    const missing = await h.call('catalog_module', { moduleId: 'atem' });
    expect(missing.isError).toBe(true);
    expect(missing.body).toMatchObject({ ok: false, code: 'MODULE_NOT_FOUND' });
    expect(missing.body['suggestions']).toContain('bmd-atem');
  });

  it('catalog_action returns action and feedback definitions and reports unknown ids', async () => {
    const action = await h.call('catalog_action', { moduleId: 'bmd-atem', actionId: 'program' });
    expect(action.body).toMatchObject({ ok: true, kind: 'action' });
    expect(action.body['definition']).toMatchObject({ id: 'program' });

    const feedback = await h.call('catalog_action', {
      moduleId: 'bmd-atem',
      actionId: 'program',
      feedback: true,
    });
    expect(feedback.body).toMatchObject({ ok: true, kind: 'feedback' });

    const unknown = await h.call('catalog_action', { moduleId: 'bmd-atem', actionId: 'prog' });
    expect(unknown.body).toMatchObject({ ok: false, code: 'ACTION_NOT_FOUND' });
    expect(unknown.body['suggestions']).toContain('program');

    const noModule = await h.call('catalog_action', { moduleId: 'nope', actionId: 'x' });
    expect(noModule.body).toMatchObject({ ok: false, code: 'MODULE_NOT_FOUND' });
  });
});

describe('generate_page', () => {
  const connection = { label: 'dev' };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['atem', { connection, inputs: 4 }],
    ['videohub', { connection, inputs: 4, outputs: 2 }],
    ['vmix', { connection, inputs: [1, 'Camera', { input: 3, label: 'Wide' }] }],
    ['birddog', { connection, presets: 6 }],
    ['showpace', { connection }],
  ];

  it.each(cases)('generates a valid %s page', async (template, params) => {
    const { body, isError } = await h.call('generate_page', { template, params });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, valid: true, errors: [] });
    const file = body['export'] as {
      version: number;
      type: string;
      instances: Record<string, unknown>;
    };
    expect(file).toMatchObject({ version: 12, type: 'page' });
    expect(Object.keys(file.instances)).toEqual(['dev']);
  });

  it('uses the connection label as id unless an id is given', async () => {
    const { body } = await h.call('generate_page', {
      template: 'atem',
      params: { connection: { label: 'dev', id: 'conn-1' }, inputs: 1 },
    });
    expect(Object.keys((body['export'] as { instances: object }).instances)).toEqual(['conn-1']);
  });

  it('reports invalid params as ok:false with issues (unknown key, out of range, wrong type)', async () => {
    const unknownKey = await h.call('generate_page', {
      template: 'atem',
      params: { connection, inputs: 2, bogus: true },
    });
    expect(unknownKey.body).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect((unknownKey.body['errors'] as unknown[]).length).toBeGreaterThan(0);

    const range = await h.call('generate_page', {
      template: 'birddog',
      params: { connection, presets: [65] },
    });
    expect(range.body).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(String(range.body['message'])).toContain('64');

    const missing = await h.call('generate_page', {
      template: 'videohub',
      params: { connection, inputs: 2 },
    });
    expect(missing.body).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });

  it('rejects an unknown template at the protocol layer', async () => {
    const result = await h.client.callTool({
      name: 'companion_generate_page',
      arguments: { template: 'resolume', params: {} },
    });
    expect(result.isError).toBe(true);
  });
});

describe('validate_config', () => {
  it('accepts a generated page', async () => {
    const page = (
      await h.call('generate_page', {
        template: 'atem',
        params: { connection: { label: 'a' }, inputs: 2 },
      })
    ).body['export'];
    const { body, isError } = await h.call('validate_config', { config: page });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, valid: true, errors: [] });
  });

  it('reports the measured pitfalls: wrong version, legacy button, missing updatePolicy, unknown module', async () => {
    const page = JSON.parse(
      JSON.stringify(
        (
          await h.call('generate_page', {
            template: 'atem',
            params: { connection: { label: 'a' }, inputs: 1 },
          })
        ).body['export'],
      ),
    );
    page.version = 17;
    page.page.controls['0']['0'].type = 'button';
    delete page.instances['a'].updatePolicy;
    page.instances['a'].moduleId = 'no-such-module';
    const { body, isError } = await h.call('validate_config', { config: page });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, valid: false, code: 'VALIDATION_FAILED' });
    const codes = (body['errors'] as Array<{ code: string }>).map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'unsupported-version',
        'connection-missing-update-policy',
        'unknown-module',
      ]),
    );
    expect(codes.some((c) => c.includes('legacy'))).toBe(true);
  });

  it('checks action options against the catalog', async () => {
    const page = JSON.parse(
      JSON.stringify(
        (
          await h.call('generate_page', {
            template: 'atem',
            params: { connection: { label: 'a' }, inputs: 1 },
          })
        ).body['export'],
      ),
    );
    const action = page.page.controls['0']['0'].steps['0'].action_sets.down[0];
    action.definitionId = 'no_such_action';
    const { body } = await h.call('validate_config', { config: page });
    expect(body.ok).toBe(false);
    expect((body['errors'] as Array<{ code: string }>).map((e) => e.code)).toContain(
      'unknown-action',
    );
  });
});

describe('build_page', () => {
  const spec = {
    pageName: 'Custom',
    connections: [{ label: 'atem', moduleId: 'bmd-atem' }],
    buttons: [
      {
        row: 0,
        column: 0,
        text: 'CAM 1',
        colors: { background: 0x333333, text: 0xffffff },
        actions: [{ connection: 'atem', actionId: 'program', options: { mixeffect: 1, input: 1 } }],
        feedbacks: [
          {
            connection: 'atem',
            feedbackId: 'program',
            options: { mixeffect: 1, input: 1 },
            style: { bgColor: 0xff0000 },
          },
        ],
      },
      { row: 1, column: 0, text: 'plain' },
    ],
  };

  it('builds a valid page with actions, feedback and style override', async () => {
    const { body, isError } = await h.call('build_page', spec);
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, valid: true });
    const file = body['export'] as {
      page: {
        name: string;
        controls: Record<
          string,
          Record<
            string,
            {
              steps: Record<string, { action_sets: { down: unknown[] } }>;
              feedbacks: Array<{ styleOverrides: unknown[] }>;
            }
          >
        >;
      };
      instances: Record<string, { updatePolicy: string }>;
    };
    expect(file.page.name).toBe('Custom');
    expect(file.instances['atem']?.updatePolicy).toBe('manual');
    const button = file.page.controls['0']?.['0'];
    expect(button?.steps['0']?.action_sets.down).toHaveLength(1);
    expect(button?.feedbacks[0]?.styleOverrides).toHaveLength(1);
  });

  it('fails with UNKNOWN_CONNECTION for a reference that is not declared', async () => {
    const bad = {
      ...spec,
      buttons: [{ row: 0, column: 0, actions: [{ connection: 'ghost', actionId: 'program' }] }],
    };
    const { body } = await h.call('build_page', bad);
    expect(body).toMatchObject({ ok: false, code: 'UNKNOWN_CONNECTION' });
  });

  it('fails with duplicate labels and with duplicate positions', async () => {
    const dup = await h.call('build_page', {
      ...spec,
      connections: [spec.connections[0], spec.connections[0]],
    });
    expect(dup.body).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    const overlap = await h.call('build_page', {
      ...spec,
      buttons: [
        { row: 0, column: 0, text: 'a' },
        { row: 0, column: 0, text: 'b' },
      ],
    });
    expect(overlap.body).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('returns the export together with validation errors for an unknown action and an out-of-range option', async () => {
    const bad = {
      ...spec,
      buttons: [
        {
          row: 0,
          column: 0,
          actions: [
            { connection: 'atem', actionId: 'no_such_action', options: {} },
            { connection: 'atem', actionId: 'program', options: { mixeffect: 0, input: 1 } },
          ],
        },
      ],
    };
    const { body, isError } = await h.call('build_page', bad);
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(body['export']).toBeDefined();
    const errors = body['errors'] as Array<{ code: string; path: string }>;
    expect(errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(['unknown-action', 'out-of-range']),
    );
    // The adapter converts catalog paths to pointers relative to the options object.
    expect(errors.find((e) => e.code === 'out-of-range')?.path).toBe(
      '/page/controls/0/0/steps/0/action_sets/down/1/options/mixeffect',
    );
  });

  it('reports a button outside an explicit grid', async () => {
    const { body } = await h.call('build_page', {
      ...spec,
      grid: { minColumn: 0, maxColumn: 1, minRow: 0, maxRow: 1 },
      buttons: [{ row: 5, column: 5, text: 'far' }],
    });
    expect(body.ok).toBe(false);
  });
});
