import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertHostAllowed, hostFromUrlOrHost, type SafetyConfig } from '../safety/index.js';
import {
  assertSupportedVersion,
  CompanionTrpc,
  RestV2Client,
  SUPPORTED_VERSION_LINE,
  TransportError,
} from '../transport/index.js';
import { withCompanion, restClient, type ToolContext } from './context.js';
import { defineTool, readOnly } from './define.js';
import { describeError, failure, redactSecrets, success, type ToolFailure } from './result.js';
import { PageNumberSchema } from './schemas.js';

function safetyView(safety: SafetyConfig) {
  return {
    writeEnabled: safety.writeEnabled,
    allowedHosts: safety.allowedHosts,
    pressAllowList:
      safety.pressAllow === null
        ? null
        : safety.pressAllow.map((entry) => `${entry.page}/${entry.row}/${entry.column}`),
  };
}

async function probeCompanion(ctx: ToolContext) {
  const client = new CompanionTrpc();
  try {
    // Connect without the version guard so that an unsupported version can be reported instead of hidden.
    await client.connect(ctx.config.url, { allowUnknownVersion: true });
    const version = client.version;
    let supported = false;
    try {
      assertSupportedVersion(version?.appVersion ?? '', false);
      supported = true;
    } catch {
      supported = false;
    }
    return {
      reachable: true,
      version: version?.appVersion ?? null,
      build: version?.appBuild ?? null,
      versionSupported: supported,
      versionAllowed: supported || ctx.config.allowUnknownVersion,
    };
  } catch (error) {
    const failed: ToolFailure = describeError(error);
    return { reachable: false, error: { code: failed.code, message: failed.message } };
  } finally {
    client.close();
  }
}

async function probeRest(ctx: ToolContext) {
  const rest = new RestV2Client(ctx.config.url, ctx.config.restToken);
  const base = { tokenConfigured: ctx.config.restToken !== undefined };
  try {
    await rest.getOpenApi();
    return { ...base, reachable: true, enabled: true };
  } catch (error) {
    if (error instanceof TransportError && error.code === 'REST_DISABLED') {
      return { ...base, reachable: true, enabled: false };
    }
    const failed = describeError(error);
    return {
      ...base,
      reachable: false,
      enabled: null,
      error: { code: failed.code, message: failed.message },
    };
  }
}

export function registerLiveTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, {
    name: 'status',
    title: 'Companion connection and safety status',
    description:
      'Reports whether Companion is reachable, its version (only 5.1.x is accepted unless COMPANION_MCP_ALLOW_UNKNOWN_VERSION is set), whether the REST API is enabled, and the active safety configuration (write gate, host allow-list; never tokens). ' +
      'Read-only: opens a short connection to the configured Companion, changes nothing. Nothing is contacted if the host is not on the allow-list.',
    input: z.strictObject({}),
    annotations: readOnly('Companion connection and safety status', true),
    run: async () => {
      const { config } = ctx;
      const host = hostFromUrlOrHost(config.url);
      const hostAllowed = config.safety.allowedHosts.includes(host);
      const problems: string[] = [];
      let companion: Record<string, unknown> = { checked: false };
      let rest: Record<string, unknown> = { checked: false };
      if (!hostAllowed) {
        problems.push(
          `Host "${host}" is not in COMPANION_MCP_ALLOWED_HOSTS; Companion was not contacted.`,
        );
      } else {
        const probed = await probeCompanion(ctx);
        companion = { checked: true, ...probed };
        if (!probed.reachable) problems.push('Companion is not reachable (tRPC).');
        else if (!probed.versionAllowed) {
          problems.push(
            `Companion ${probed.version ?? '?'} is not ${SUPPORTED_VERSION_LINE}.x; set COMPANION_MCP_ALLOW_UNKNOWN_VERSION=1 to proceed at your own risk.`,
          );
        }
        rest = { checked: true, ...(await probeRest(ctx)) };
      }
      return success({
        ready: problems.length === 0,
        problems,
        target: { url: config.url, host, hostAllowed },
        companion,
        rest,
        safety: safetyView(config.safety),
        allowUnknownVersion: config.allowUnknownVersion,
      });
    },
  });

  defineTool(server, {
    name: 'export',
    title: 'Export the Companion configuration',
    description:
      'Exports the live configuration as JSON: the full configuration (scope "full") or one page ({ "page": n }, 1-based). Read-only on Companion (HTTP export, no change), host allow-list and version guard apply. ' +
      'A page export can be used as a snapshot or as a template for companion_import_page.',
    input: z.strictObject({
      scope: z.union([z.literal('full'), z.strictObject({ page: PageNumberSchema })]),
    }),
    annotations: readOnly('Export the Companion configuration', true),
    run: async ({ scope }) =>
      withCompanion(ctx, async (client) => {
        const file =
          scope === 'full' ? await client.exportFull() : await client.exportPage(scope.page);
        return success({ scope, export: file });
      }),
  });

  defineTool(server, {
    name: 'get_page',
    title: 'Read a page back from Companion',
    description:
      'Reads the current content of one page (1-based) directly from Companion: name and the config of every control, in the same layout as `page.controls` of an export. Read-only; host allow-list and version guard apply. ' +
      'Use it to verify a change independently of the import result.',
    input: z.strictObject({ page: PageNumberSchema }),
    annotations: readOnly('Read a page back from Companion', true),
    run: async ({ page }) =>
      withCompanion(ctx, async (client) => {
        const readback = await client.getPage(page);
        return success({
          page: readback.pageNumber,
          name: readback.name,
          controlCount: readback.list.length,
          controls: readback.controls,
        });
      }),
  });

  defineTool(server, {
    name: 'list_connections',
    title: 'List Companion connections',
    description:
      'Lists the connections (module instances) of Companion through the REST API v2. Needs COMPANION_REST_TOKEN and the REST API enabled in Companion (off by default). Read-only; host allow-list applies. ' +
      'Secret-looking fields are redacted.',
    input: z.strictObject({}),
    annotations: readOnly('List Companion connections', true),
    run: async () => listRest(ctx, 'connections'),
  });

  defineTool(server, {
    name: 'list_surfaces',
    title: 'List Companion surfaces',
    description:
      'Lists the surfaces (Stream Deck and other controllers) known to Companion through the REST API v2. Needs COMPANION_REST_TOKEN and the REST API enabled in Companion. Read-only; host allow-list applies.',
    input: z.strictObject({}),
    annotations: readOnly('List Companion surfaces', true),
    run: async () => listRest(ctx, 'surfaces'),
  });
}

async function listRest(ctx: ToolContext, what: 'connections' | 'surfaces') {
  assertHostAllowed(ctx.config.safety, ctx.config.url);
  if (ctx.config.restToken === undefined) {
    return failure({
      code: 'REST_TOKEN_MISSING',
      message:
        'COMPANION_REST_TOKEN is not set. Enable the REST API in the Companion settings, create an API token and pass it as COMPANION_REST_TOKEN.',
      source: 'config',
    });
  }
  const rest = restClient(ctx);
  const items = what === 'connections' ? await rest.listConnections() : await rest.listSurfaces();
  return success({ count: items.length, [what]: redactSecrets(items) });
}
