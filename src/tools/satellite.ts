import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertHostAllowed, assertWriteAllowed, hostFromUrlOrHost } from '../safety/index.js';
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_TCP_PORT,
  fingerprintKey,
  planPress,
  pressVerified,
  SatelliteClient,
  type DeckKey,
  type KeyDiff,
  type PageSnapshot,
  type VirtualDeck,
} from '../satellite/index.js';
import type { ToolContext } from './context.js';
import { defineTool, readOnly } from './define.js';
import { success } from './result.js';

const DECK_DEFAULT = { keys_total: 32, keys_per_row: 8 };
const BITMAP_SIZE = 72;

const DeckSchema = z
  .strictObject({
    keys_total: z.number().int().min(1).max(256).default(DECK_DEFAULT.keys_total),
    keys_per_row: z.number().int().min(1).max(64).default(DECK_DEFAULT.keys_per_row),
  })
  .refine((deck) => deck.keys_per_row <= deck.keys_total, {
    message: 'deck.keys_per_row must not exceed deck.keys_total',
  })
  .default(DECK_DEFAULT)
  .describe(
    'Geometry of the virtual surface (default 32 keys, 8 per row). Only keys inside it can be read or pressed.',
  );

const ConnectionFields = {
  host: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'Satellite host. Default: the host of COMPANION_URL. Must be on the host allow-list.',
    ),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe(`Satellite TCP port. Default ${DEFAULT_TCP_PORT}.`),
  deck: DeckSchema,
};

const START_PAGE_NOTE =
  'The virtual surface starts on page 1 and keeps its last page when the same device id reconnects; this server cannot choose the page (that needs Companion internals). Pages other than the one shown need a page navigation key.';

interface ConnectionArgs {
  host?: string | undefined;
  port?: number | undefined;
  deck: { keys_total: number; keys_per_row: number };
}

/** Resolved target of a Satellite call (host is checked against the allow-list before anything is opened). */
function resolveTarget(ctx: ToolContext, args: ConnectionArgs): { host: string; port: number } {
  const host = hostFromUrlOrHost(args.host ?? ctx.config.url);
  assertHostAllowed(ctx.config.safety, host);
  return { host, port: args.port ?? DEFAULT_TCP_PORT };
}

/**
 * One Satellite session per tool call: connect, register the virtual deck, run, then always remove the device and
 * close. Calls are serialized because they share the fixed DEVICEID.
 */
async function withDeck<T>(
  ctx: ToolContext,
  args: ConnectionArgs & { timeout_ms: number; bitmaps?: boolean },
  fn: (client: SatelliteClient, deck: VirtualDeck, warnings: string[]) => Promise<T>,
): Promise<T> {
  const { host, port } = resolveTarget(ctx, args);
  return ctx.satelliteQueue.run(async () => {
    const client = new SatelliteClient({ safety: ctx.config.safety });
    try {
      const info = await client.connect(host, port, { timeoutMs: args.timeout_ms });
      const deck = await client.addDevice({
        deviceId: DEFAULT_DEVICE_ID,
        keysTotal: args.deck.keys_total,
        keysPerRow: args.deck.keys_per_row,
        ...(args.bitmaps === true ? { bitmapSize: BITMAP_SIZE, bitmapFormat: 'png' as const } : {}),
        timeoutMs: args.timeout_ms,
      });
      return await fn(client, deck, [...info.warnings]);
    } finally {
      await client.close();
    }
  });
}

/** Fingerprint without the bitmap, so that it matches between calls with and without `include_bitmaps`. */
function stableFingerprint(key: DeckKey): string {
  return fingerprintKey({ ...key, bitmap: null });
}

function keyView(key: DeckKey, includeBitmap: boolean) {
  return {
    row: key.location.row,
    column: key.location.column,
    key: key.key,
    text: key.text,
    color: key.color,
    text_color: key.textColor,
    font_size: key.fontSize,
    key_type: key.keyType,
    empty: key.text === '' && (key.color === null || key.color === '#000000'),
    fingerprint: stableFingerprint(key),
    ...(includeBitmap && key.bitmap !== null
      ? { bitmap: { format: key.bitmap.format, base64: key.bitmap.base64 } }
      : {}),
  };
}

function changeView(diff: KeyDiff) {
  const side = (key: DeckKey | null) =>
    key === null ? null : { text: key.text, color: key.color, text_color: key.textColor };
  return {
    row: diff.row,
    column: diff.column,
    changed: diff.changed,
    before: side(diff.before),
    after: side(diff.after),
  };
}

function snapshotView(snapshot: PageSnapshot, includeBitmaps: boolean) {
  return {
    page: snapshot.page,
    complete: snapshot.complete,
    stale_cells: snapshot.staleCells,
    locked: snapshot.locked,
    keys: snapshot.cells.map((cell) => keyView(cell, includeBitmaps)),
  };
}

export function registerSatelliteTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, {
    name: 'satellite_snapshot',
    title: 'Read what the buttons of a page show',
    description:
      "Registers a virtual Stream Deck surface through the Companion Satellite API (TCP, default port 16622), waits for a quiet, complete page and returns the grid: row, column, text, color per key and, with include_bitmaps, the rendered bitmap (base64 plus format; it includes Companion's top bar). " +
      'Read-only: nothing is pressed or changed in the configuration, and the surface is removed again. Note that Companion keeps a permanent surface entry for the device id "mcp-virtual-deck". ' +
      `Host allow-list applies (COMPANION_MCP_ALLOWED_HOSTS). ${START_PAGE_NOTE} page_hint only waits until the keys show that page; it does not change the page. ` +
      'Each key carries a fingerprint that can be passed to companion_press as expect_fingerprint.',
    input: z.strictObject({
      ...ConnectionFields,
      page_hint: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Wait until every key belongs to this page (does not switch pages).'),
      quiet_ms: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .default(300)
        .describe('Silence required after the last key update.'),
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(60_000)
        .default(10_000)
        .describe('Budget for connecting and for the snapshot, each.'),
      include_bitmaps: z.boolean().default(false),
    }),
    annotations: readOnly('Read what the buttons of a page show', true),
    run: async (args) =>
      withDeck(ctx, { ...args, bitmaps: args.include_bitmaps }, async (_client, deck, warnings) => {
        const snapshot = await deck.snapshotPage({
          quietMs: args.quiet_ms,
          timeoutMs: args.timeout_ms,
          ...(args.page_hint === undefined ? {} : { page: args.page_hint }),
        });
        if (!snapshot.complete) {
          warnings.push(
            `The snapshot is incomplete (${snapshot.cells.length} of ${deck.keysTotal} keys, ${snapshot.staleCells} stale).`,
          );
        }
        return success({
          ...snapshotView(snapshot, args.include_bitmaps),
          deck: { keys_total: deck.keysTotal, keys_per_row: deck.keysPerRow, rows: deck.rows },
          warnings,
          note: START_PAGE_NOTE,
        });
      }),
  });

  defineTool(server, {
    name: 'press',
    title: 'Press a Companion button',
    description:
      'Presses one button (0-based row and column on the page the virtual surface shows) through the Companion Satellite API. THIS CAN TRIGGER ACTIONS ON LIVE EQUIPMENT. ' +
      'dry_run defaults to true: it reads the key and returns the plan (current content, gate status, the exact lines that would be sent) and sends nothing. ' +
      'With dry_run=false it needs COMPANION_MCP_WRITE=1, an allowed host and, if set, the button in COMPANION_MCP_PRESS_ALLOW (page/row/column). The key is read right before pressing; a locked surface is refused. ' +
      'expect_fingerprint (from companion_satellite_snapshot or a dry run) refuses the press with KEY_CHANGED if the key looks different now. ' +
      'Result: accepted (Companion answered OK, which it also does for empty keys), render_changed, target_changed and page_changed (what the surface displays afterwards) with before/after. None of these proves the intended effect: verify that independently. ' +
      START_PAGE_NOTE,
    input: z.strictObject({
      row: z.number().int().min(0).max(255),
      column: z.number().int().min(0).max(255),
      dry_run: z.boolean().default(true),
      expect_fingerprint: z.string().min(1).max(128).optional(),
      ...ConnectionFields,
      quiet_ms: z.number().int().min(0).max(10_000).default(250),
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(60_000)
        .default(10_000)
        .describe('Budget for connecting and for the first snapshot.'),
      change_timeout_ms: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .default(2000)
        .describe('How long to wait for a render change after the press.'),
    }),
    annotations: {
      title: 'Press a Companion button',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: async (args) => {
      // Refuse a real press early, before any socket is opened.
      if (!args.dry_run) {
        const { host } = resolveTarget(ctx, args);
        assertWriteAllowed(ctx.config.safety, host);
      }
      return withDeck(ctx, args, async (client, deck, warnings) => {
        const options = {
          quietMs: args.quiet_ms,
          snapshotTimeoutMs: args.timeout_ms,
          changeTimeoutMs: args.change_timeout_ms,
          ...(args.expect_fingerprint === undefined
            ? {}
            : { expectFingerprint: args.expect_fingerprint }),
        };
        if (args.dry_run) {
          const plan = await planPress(client, deck, args.row, args.column, options);
          return success({
            dry_run: true,
            sent: false,
            location: plan.location,
            current: keyView(plan.current, false),
            fingerprint: stableFingerprint(plan.current),
            empty: plan.empty,
            locked: plan.locked,
            gate: plan.gate,
            would_send: plan.wouldSend,
            would_be_allowed: plan.gate.allowed && !plan.locked,
            fingerprint_matches:
              args.expect_fingerprint === undefined
                ? null
                : args.expect_fingerprint === stableFingerprint(plan.current),
            warnings,
            message: 'Dry run: nothing was sent. Run again with dry_run=false to press.',
          });
        }
        const result = await pressVerified(client, deck, args.row, args.column, {
          dryRun: false,
          ...options,
        });
        return success({
          dry_run: false,
          sent: true,
          accepted: true,
          level: result.level,
          render_changed: result.renderChanged,
          target_changed: result.targetChanged,
          page_changed: result.pageChanged,
          location: result.location,
          changes: result.changes.map(changeView),
          before: keyView(result.before, false),
          after: result.after === null ? null : keyView(result.after, false),
          ack_ms: result.ackMs,
          warnings: [...warnings, ...result.warnings],
          note: 'accepted only means Companion answered OK (it also does for empty keys). render_changed means the surface looks different afterwards. Neither proves the intended effect; verify it independently.',
        });
      });
    },
  });
}
