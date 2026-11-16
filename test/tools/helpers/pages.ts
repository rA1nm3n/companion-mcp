import type { JsonObject } from '../../../src/safety/json.js';

/** Minimal valid page export built by the real template tool; used as import payload. */
export async function atemPage(
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ body: { ok: boolean; [k: string]: unknown } }>,
  pageName = 'TOOLS TEST',
): Promise<JsonObject> {
  const { body } = await call('generate_page', {
    template: 'atem',
    params: { connection: { label: 'atem' }, inputs: 2, pageName },
  });
  if (!body.ok) throw new Error(`generate_page failed: ${JSON.stringify(body)}`);
  return body['export'] as JsonObject;
}
