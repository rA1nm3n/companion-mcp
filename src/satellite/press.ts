import { assertPressAllowed, SafetyError } from '../safety/index.js';
import type { SatelliteClient } from './client.js';
import {
  diffSnapshots,
  fingerprintKey,
  findKey,
  type DeckKey,
  type KeyDiff,
  type PageSnapshot,
  type VirtualDeck,
} from './deck.js';
import { SatelliteError } from './errors.js';
import { serializeCommand } from './protocol.js';

export interface GateStatus {
  allowed: boolean;
  /** `SafetyErrorCode` (`WRITE_DISABLED`, `HOST_NOT_ALLOWED`, `PRESS_NOT_ALLOWED`, ...) when refused. */
  code?: string;
  reason?: string;
}

export interface PressOptions {
  /** Required on purpose: `true` sends nothing and returns the plan, `false` presses. */
  dryRun: boolean;
  /** Read-before-press binding: refuse if the key no longer shows what an earlier read/plan showed. */
  expectFingerprint?: string;
  /** Silence required for the snapshots and for settling after a change. Default 150 ms. */
  quietMs?: number;
  /** Timeout for the initial snapshot. Default 5000 ms. */
  snapshotTimeoutMs?: number;
  /** How long to wait for a render change after the press. Default 1000 ms. */
  changeTimeoutMs?: number;
  /** Time between key down and key up. Default 30 ms. */
  holdMs?: number;
  /** Timeout for the server's `OK` per KEY-PRESS. Default 1000 ms. */
  ackTimeoutMs?: number;
}

export interface PressPlan {
  dryRun: true;
  sent: false;
  /** Companion button that would be pressed. */
  location: { page: number; row: number; column: number };
  /** Index on the virtual deck. */
  key: number;
  /** Current content of the key, read just now. */
  current: DeckKey;
  /** Identity of what was read; pass as `expectFingerprint` to bind a later press to it. */
  fingerprint: string;
  /** No text and black: pressing it will most likely do nothing. */
  empty: boolean;
  locked: boolean;
  gate: GateStatus;
  /** Exact lines that would be sent. */
  wouldSend: string[];
}

/**
 * Outcome of a real press. `accepted` only means the server answered `OK` (which it also does for empty keys,
 * locked surfaces and ignored page changes). `render_changed` means a KEY-STATE with a different look arrived.
 * Neither proves the intended effect (for example a variable value); that needs an independent check.
 */
export interface PressResult {
  dryRun: false;
  sent: true;
  level: 'accepted' | 'render_changed';
  /** Any key of the page looks different after the press than before. */
  renderChanged: boolean;
  /** The pressed key itself looks different. */
  targetChanged: boolean;
  /** The page shown changed (navigation key, or an operator switched the page meanwhile). */
  pageChanged: boolean;
  location: { page: number; row: number; column: number };
  key: number;
  before: DeckKey;
  /** The pressed key after settling, null if it is gone. */
  after: DeckKey | null;
  /** All keys whose render changed (`pressed` flicker excluded). */
  changes: KeyDiff[];
  fingerprintBefore: string;
  ackMs: number;
  warnings: string[];
}

const LOCK_ICON = '\u{1F512}';

function isEmpty(key: DeckKey): boolean {
  return key.text === '' && (key.color === null || key.color === '#000000');
}

function gateStatus(client: SatelliteClient, location: PressPlan['location']): GateStatus {
  try {
    if (client.host === null)
      return { allowed: false, code: 'NOT_CONNECTED', reason: 'Not connected' };
    assertPressAllowed(client.safety, client.host, location);
    return { allowed: true };
  } catch (error) {
    if (error instanceof SafetyError) {
      return { allowed: false, code: error.code, reason: error.message };
    }
    throw error;
  }
}

function checkInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new SatelliteError('INVALID_ARGUMENT', `${name} must be a non-negative integer`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTarget(
  deck: VirtualDeck,
  row: number,
  column: number,
  options: PressOptions,
): Promise<{ snapshot: PageSnapshot; key: DeckKey }> {
  checkInteger('row', row);
  checkInteger('column', column);
  const snapshot = await deck.snapshotPage({
    quietMs: options.quietMs ?? 150,
    timeoutMs: options.snapshotTimeoutMs ?? 5000,
  });
  const key = findKey(snapshot, row, column);
  if (key === null) {
    throw new SatelliteError(
      'KEY_NOT_FOUND',
      `Row ${row} / column ${column} is not shown on the virtual deck (page ${snapshot.page ?? '?'}, ${snapshot.cells.length} keys)`,
    );
  }
  return { snapshot, key };
}

/** Read-only: reads the key and reports what a press would do. Sends nothing. */
export async function planPress(
  client: SatelliteClient,
  deck: VirtualDeck,
  row: number,
  column: number,
  options: Omit<PressOptions, 'dryRun'> = {},
): Promise<PressPlan> {
  const { snapshot, key } = await readTarget(deck, row, column, { ...options, dryRun: true });
  return {
    dryRun: true,
    sent: false,
    location: key.location,
    key: key.key,
    current: key,
    fingerprint: fingerprintKey(key),
    empty: isEmpty(key),
    locked: snapshot.locked || key.text.includes(LOCK_ICON),
    gate: gateStatus(client, key.location),
    wouldSend: [
      serializeCommand({ type: 'key-press', deviceId: deck.deviceId, key: key.key, pressed: true }),
      serializeCommand({
        type: 'key-press',
        deviceId: deck.deviceId,
        key: key.key,
        pressed: false,
      }),
    ],
  };
}

export async function pressVerified(
  client: SatelliteClient,
  deck: VirtualDeck,
  row: number,
  column: number,
  options: PressOptions & { dryRun: true },
): Promise<PressPlan>;
export async function pressVerified(
  client: SatelliteClient,
  deck: VirtualDeck,
  row: number,
  column: number,
  options: PressOptions & { dryRun: false },
): Promise<PressResult>;
/**
 * Presses a Companion button through the virtual deck with read-before-press and render verification.
 *
 * Order: read the key (snapshot), refuse locked surfaces, run the press gate (`assertPressAllowed`: write flag,
 * host allow-list, press allow-list; throws `SafetyError`), compare against `expectFingerprint`, send KEY-PRESS
 * down and (always) up, then wait for a render change. Never reports success from `OK` alone.
 */
export async function pressVerified(
  client: SatelliteClient,
  deck: VirtualDeck,
  row: number,
  column: number,
  options: PressOptions,
): Promise<PressPlan | PressResult> {
  if (options.dryRun) return planPress(client, deck, row, column, options);

  const quietMs = options.quietMs ?? 150;
  const { snapshot: beforeSnapshot, key: before } = await readTarget(deck, row, column, options);

  if (beforeSnapshot.locked || before.text.includes(LOCK_ICON)) {
    throw new SatelliteError(
      'SURFACE_LOCKED',
      'The surface is locked (PIN or lock icon); Companion would answer OK but run nothing',
    );
  }
  assertPressAllowed(client.safety, client.host ?? '', before.location);

  const fingerprintBefore = fingerprintKey(before);
  if (options.expectFingerprint !== undefined && options.expectFingerprint !== fingerprintBefore) {
    throw new SatelliteError(
      'KEY_CHANGED',
      `Key ${before.location.page}/${row}/${column} no longer shows what was read earlier; press refused`,
    );
  }
  // Last look right before sending (a page change by an operator can happen at any time).
  const latest = deck.getKey(row, column, before.location.page);
  if (latest === null || fingerprintKey(latest) !== fingerprintBefore) {
    throw new SatelliteError(
      'KEY_CHANGED',
      `Key ${before.location.page}/${row}/${column} changed while preparing the press; refused`,
    );
  }

  const warnings: string[] = [];
  const ackTimeoutMs = options.ackTimeoutMs ?? 1000;
  let ackMs = 0;
  let downSent = false;
  try {
    ackMs = (await client.keyPress(deck.deviceId, before.key, true, before.location, ackTimeoutMs))
      .ackMs;
    downSent = true;
    await sleep(options.holdMs ?? 30);
  } finally {
    // The release is sent in every case once a press may have started; it is never gated.
    try {
      await client.keyPress(deck.deviceId, before.key, false, before.location, ackTimeoutMs);
    } catch (error) {
      if (downSent) {
        warnings.push(
          `Release (PRESSED=0) failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Wait for any change versus the read state, then let the page settle and compare again.
  const deadline = Date.now() + (options.changeTimeoutMs ?? 1000);
  let sawChange = false;
  for (;;) {
    const current = deck.peekSnapshot();
    if (current.page !== beforeSnapshot.page || diffSnapshots(beforeSnapshot, current).length > 0) {
      sawChange = true;
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await deck.waitForUpdate(remaining);
  }
  let afterSnapshot = deck.peekSnapshot();
  if (sawChange) {
    // Settle: quiet again, and the pressed key must have reported its release (PRESSED=0) unless time is up.
    const settleDeadline = Date.now() + Math.max(1000, quietMs * 10);
    for (;;) {
      afterSnapshot = await deck.snapshotPage({
        quietMs,
        timeoutMs: Math.max(1, settleDeadline - Date.now()),
      });
      if (findKey(afterSnapshot, row, column)?.pressed !== true) break;
      const remaining = settleDeadline - Date.now();
      if (remaining <= 0) break;
      await deck.waitForUpdate(remaining);
    }
  }

  const changes = diffSnapshots(beforeSnapshot, afterSnapshot);
  const pageChanged = afterSnapshot.page !== beforeSnapshot.page;
  const after = findKey(afterSnapshot, row, column);
  const targetChanged = changes.some((diff) => diff.row === row && diff.column === column);
  if (after?.pressed) warnings.push('The key still reports PRESSED=1 after the release.');
  const renderChanged = changes.length > 0 || pageChanged;

  return {
    dryRun: false,
    sent: true,
    level: renderChanged ? 'render_changed' : 'accepted',
    renderChanged,
    targetChanged,
    pageChanged,
    location: before.location,
    key: before.key,
    before,
    after,
    changes,
    fingerprintBefore,
    ackMs,
    warnings,
  };
}
