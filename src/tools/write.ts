import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateExport, type ValidationResult } from '../format/index.js';
import {
  assertHostAllowed,
  assertWriteAllowed,
  createSnapshot,
  hostFromUrlOrHost,
  isJsonObject,
  planPageImport,
  planRollback,
  planWrite,
  SafetyError,
  type JsonObject,
  type Snapshot,
} from '../safety/index.js';
import { diffReadback, type CompanionTrpc, type ReadbackResult } from '../transport/index.js';
import { catalogLookup } from './catalog-adapter.js';
import { withCompanion, type ToolContext } from './context.js';
import { defineTool } from './define.js';
import { failure, failureFrom, success } from './result.js';
import {
  adaptIntended,
  createdConnections,
  existingConnectionIds,
  identityMapping,
  remappingOf,
} from './readback-adapt.js';
import { JsonObjectSchema, TargetPageSchema } from './schemas.js';

const SnapshotSchema = z.strictObject({
  createdAt: z.string().min(1),
  host: z.string().min(1),
  scope: z.union([
    z.strictObject({ kind: z.literal('full') }),
    z.strictObject({ kind: z.literal('page'), page: z.number().int().min(1) }),
  ]),
  companionVersion: z.string().optional(),
  checksum: z.string().min(1),
  exportFile: JsonObjectSchema,
});

function readbackBody(result: ReadbackResult) {
  return {
    ok: result.ok,
    summary: result.summary,
    deviations: result.deviations,
  };
}

/** Number of the page that an appended import created: the last page after the import. */
async function pageCount(client: CompanionTrpc): Promise<number> {
  const pages = await client.firstOfSubscription('pages.watch');
  if (isJsonObject(pages) && Array.isArray(pages['order'])) return pages['order'].length;
  throw new SafetyError('CONFIG_INVALID', 'pages.watch returned an unexpected shape');
}

function validationFailure(result: ValidationResult) {
  return failure(
    {
      code: 'VALIDATION_FAILED',
      message: `The export has ${result.errors.length} validation error(s); nothing was sent.`,
      source: 'validation',
    },
    { errors: result.errors, warnings: result.warnings },
  );
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, {
    name: 'import_page',
    title: 'Import a page into Companion',
    description:
      'Imports a page export (type "page") into the live Companion. dry_run defaults to true and only returns the plan (validation, planned steps, gates that would block) without contacting Companion. ' +
      'With dry_run=false it REPLACES the target page (or appends with target_page=-1) and needs COMPANION_MCP_WRITE=1 and an allowed host. The import may also create connections that the file contains and are not mapped via connection_mapping. ' +
      'Sequence: validate, snapshot of the target page (export, with checksum), import, read back and diff. ok is false if the read-back shows any error, for example a control that Companion silently dropped; the result then still carries the snapshot for companion_rollback. ' +
      'Imports run one at a time (Companion allows one upload session).',
    input: z.strictObject({
      config: JsonObjectSchema.describe(
        'Page export, for example from companion_generate_page or companion_build_page.',
      ),
      target_page: TargetPageSchema.describe(
        'Page number to replace (>= 1) or -1 to append a new page.',
      ),
      connection_mapping: z
        .record(z.string(), z.string())
        .optional()
        .describe('Maps connection ids in the file to ids of existing Companion connections.'),
      dry_run: z.boolean().default(true),
    }),
    annotations: {
      title: 'Import a page into Companion',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: async ({
      config,
      target_page: targetPage,
      connection_mapping: mapping,
      dry_run: dryRun,
    }) => {
      const { safety, url } = ctx.config;
      const validation = validateExport(config, { catalog: catalogLookup });
      if (!validation.ok) return validationFailure(validation);
      if (config['type'] !== 'page') {
        return failure({
          code: 'UNSUPPORTED_EXPORT_TYPE',
          message: `Only exports of type "page" can be imported (got "${String(config['type'])}").`,
          source: 'input',
        });
      }
      assertHostAllowed(safety, url);

      const warnings = validation.warnings.map((issue) => `${issue.path}: ${issue.message}`);
      if (mapping !== undefined) {
        const fileInstances = isJsonObject(config['instances']) ? config['instances'] : {};
        for (const key of Object.keys(mapping)) {
          if (!(key in fileInstances)) {
            warnings.push(`connection_mapping key "${key}" is not a connection id of the file.`);
          }
        }
      }

      const instances = isJsonObject(config['instances']) ? config['instances'] : {};
      for (const [id, instance] of Object.entries(instances)) {
        if (mapping !== undefined && id in mapping) continue;
        const label = isJsonObject(instance) ? String(instance['label']) : id;
        warnings.push(
          `Connection "${label}" (file id "${id}") is not mapped: the import creates a NEW connection (a repeated import creates another one). Pass connection_mapping to reuse an existing connection.`,
        );
      }

      if (dryRun) {
        const plan = planPageImport(safety, url, config, targetPage);
        return success({
          dry_run: true,
          plan: { ...plan, warnings: [...plan.warnings, ...warnings] },
          validation: { valid: true, warnings: validation.warnings },
          message: plan.wouldBeAllowed
            ? 'Dry run: nothing was sent. Run again with dry_run=false to apply.'
            : `Dry run: nothing was sent. The real run would be refused (${plan.blockedBy.join(', ')}).`,
        });
      }

      assertWriteAllowed(safety, url);
      return ctx.writeQueue.run(() => applyImport(ctx, config, targetPage, mapping, warnings));
    },
  });

  defineTool(server, {
    name: 'rollback',
    title: 'Roll back to a snapshot',
    description:
      'Restores a page snapshot (from companion_import_page) by re-importing it into the same page number. dry_run defaults to true: it only verifies the checksum and returns the plan. ' +
      'With dry_run=false it REPLACES that page again and needs COMPANION_MCP_WRITE=1 and an allowed host; a snapshot of the current page is taken first and returned, so the rollback itself can be undone. ' +
      'A modified snapshot (checksum mismatch) or a snapshot of another host is refused. Appended pages have no snapshot and cannot be rolled back this way (delete the page in Companion).',
    input: z.strictObject({
      snapshot: SnapshotSchema.describe(
        'The snapshot object exactly as returned by companion_import_page.',
      ),
      dry_run: z.boolean().default(true),
    }),
    annotations: {
      title: 'Roll back to a snapshot',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: async ({ snapshot: raw, dry_run: dryRun }) => {
      const { safety, url } = ctx.config;
      const snapshot = raw as Snapshot;
      const plan = planRollback(snapshot); // throws SNAPSHOT_INVALID on a checksum mismatch
      if (snapshot.scope.kind !== 'page') {
        return failure({
          code: 'UNSUPPORTED_SNAPSHOT_SCOPE',
          message: 'Only page snapshots can be rolled back; full imports are not supported.',
          source: 'input',
        });
      }
      assertHostAllowed(safety, url);
      const currentHost = hostFromUrlOrHost(url);
      if (hostFromUrlOrHost(snapshot.host) !== currentHost) {
        return failure({
          code: 'SNAPSHOT_HOST_MISMATCH',
          message: `The snapshot was taken on host "${snapshot.host}", the configured host is "${currentHost}".`,
          source: 'safety',
        });
      }
      const page = snapshot.scope.page;
      if (dryRun) {
        return success({
          dry_run: true,
          checksum_valid: true,
          plan: planWrite(
            safety,
            url,
            [
              {
                kind: 'snapshot',
                scope: 'page',
                page,
                description: `Export the current page ${page} (so the rollback can be undone)`,
              },
              ...plan.description,
              { kind: 'readback', description: 'Read the page back and diff against the snapshot' },
            ],
            [
              'Connections of the snapshot that still exist are reused; missing ones are re-created as new connections.',
            ],
          ),
          message: 'Dry run: nothing was sent. Run again with dry_run=false to apply.',
        });
      }
      assertWriteAllowed(safety, url);
      return ctx.writeQueue.run(() => applyRollback(ctx, snapshot, page, plan.operations));
    },
  });
}

async function applyImport(
  ctx: ToolContext,
  config: JsonObject,
  targetPage: number,
  mapping: Record<string, string> | undefined,
  warnings: string[],
) {
  const host = hostFromUrlOrHost(ctx.config.url);
  let snapshot: Snapshot | undefined;
  let imported = false;
  let created: ReturnType<typeof createdConnections> = [];
  try {
    return await withCompanion(ctx, async (client) => {
      if (targetPage !== -1) {
        snapshot = createSnapshot({
          host,
          scope: { kind: 'page', page: targetPage },
          exportFile: await client.exportPage(targetPage),
          ...(client.version === undefined ? {} : { companionVersion: client.version.appVersion }),
        });
      }
      imported = true; // from here on the outcome on Companion may differ from the previous state
      const result = await client.importPage({
        exportFile: config,
        targetPage,
        ...(mapping === undefined ? {} : { connectionMapping: mapping }),
      });
      const remapping = remappingOf(result.remapping);
      created = createdConnections(config, remapping, mapping);
      const resolvedPage = targetPage === -1 ? await pageCount(client) : targetPage;
      const readback = await client.getPage(resolvedPage);
      const diff = diffReadback(
        adaptIntended(config, remapping),
        readback as unknown as JsonObject,
      );
      const common = {
        dry_run: false,
        target_page: resolvedPage,
        appended: targetPage === -1,
        readback: readbackBody(diff),
        created_connections: created,
        snapshot: snapshot === undefined ? null : snapshot,
        rollback:
          snapshot === undefined
            ? 'Appended page: no snapshot exists. To undo, delete the page in Companion.'
            : 'Pass the snapshot to companion_rollback (dry_run=false) to restore the previous page.',
        warnings,
      };
      if (diff.ok) return success(common);
      return failure(
        {
          code: 'READBACK_MISMATCH',
          message: `The read-back differs from the intended page (${diff.deviations.filter((d) => d.severity === 'error').length} error(s), ${diff.summary.controlsDropped} dropped control(s)).`,
          source: 'validation',
        },
        common,
      );
    });
  } catch (error) {
    // The outcome is unknown after a failure past the snapshot: always hand the snapshot back.
    return failureFrom(error, {
      dry_run: false,
      import_attempted: imported,
      created_connections: created,
      snapshot: snapshot === undefined ? null : snapshot,
      ...(imported
        ? {
            hint: 'The state of the page is unknown. Read it with companion_get_page before retrying.',
          }
        : {}),
    });
  }
}

async function applyRollback(
  ctx: ToolContext,
  snapshot: Snapshot,
  page: number,
  operations: ReturnType<typeof planRollback>['operations'],
) {
  const host = hostFromUrlOrHost(ctx.config.url);
  let before: Snapshot | undefined;
  let imported = false;
  try {
    return await withCompanion(ctx, async (client) => {
      before = createSnapshot({
        host,
        scope: { kind: 'page', page },
        exportFile: await client.exportPage(page),
        ...(client.version === undefined ? {} : { companionVersion: client.version.appVersion }),
      });
      // Reuse connections that still exist: a re-import without mapping would create duplicates.
      const mapping = identityMapping(snapshot.exportFile, await existingConnectionIds(client));
      imported = true;
      let remapping: Record<string, string> = {};
      for (const operation of operations) {
        if (operation.kind !== 'import-page' || operation.targetPage === undefined) continue;
        const result = await client.importPage({
          exportFile: operation.exportFile,
          targetPage: operation.targetPage,
          connectionMapping: mapping,
        });
        remapping = remappingOf(result.remapping);
      }
      const readback = await client.getPage(page);
      const diff = diffReadback(
        adaptIntended(snapshot.exportFile, remapping),
        readback as unknown as JsonObject,
      );
      const common = {
        dry_run: false,
        target_page: page,
        readback: readbackBody(diff),
        created_connections: createdConnections(snapshot.exportFile, remapping, mapping),
        pre_rollback_snapshot: before,
      };
      if (diff.ok) return success(common);
      return failure(
        {
          code: 'READBACK_MISMATCH',
          message: 'The page after the rollback differs from the snapshot.',
          source: 'validation',
        },
        common,
      );
    });
  } catch (error) {
    return failureFrom(error, {
      dry_run: false,
      import_attempted: imported,
      pre_rollback_snapshot: before ?? null,
    });
  }
}
