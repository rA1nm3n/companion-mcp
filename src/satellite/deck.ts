import { createHash } from 'node:crypto';
import { SatelliteError } from './errors.js';
import type { Bitmap, BitmapFormat, KeyLocation, ServerMessage } from './protocol.js';

/** One button as last drawn by Companion. `bitmap` includes Companion's topbar, `text` does not. */
export interface DeckKey {
  /** Legacy key index of the virtual deck (what `KEY-PRESS` addresses). */
  key: number;
  /** The Companion button this key currently shows (page/row/column). */
  location: KeyLocation;
  text: string;
  /** `#rrggbb` with `COLORS=hex`. */
  color: string | null;
  textColor: string | null;
  fontSize: number | 'auto' | null;
  keyType: string | null;
  /** True only while the button is held down. Transient, never counted as a render change. */
  pressed: boolean;
  bitmap: Bitmap | null;
  /** Milliseconds since epoch of the last KEY-STATE for this key. */
  receivedAt: number;
}

export interface PageSnapshot {
  deviceId: string;
  /** The page the snapshot describes (null if the deck has not received any key yet). */
  page: number | null;
  takenAt: number;
  /** Keys of `page`, sorted by row, then column. */
  cells: DeckKey[];
  /** `grid[row - originRow][column - originColumn]`; null where Companion sent nothing. */
  grid: Array<Array<DeckKey | null>>;
  originRow: number;
  originColumn: number;
  /** Number of keys last drawn for a different page (late or stale KEY-STATE). */
  staleCells: number;
  /** Every key of the deck is present and belongs to `page`. */
  complete: boolean;
  locked: boolean;
  brightness: number | null;
}

export interface SnapshotOptions {
  /** Silence required after the last KEY-STATE. Default 150 ms. */
  quietMs?: number;
  /** Upper bound for the whole wait. Default 5000 ms. */
  timeoutMs?: number;
  /** Wait until every key of the deck shows this page (late KEY-STATE after page changes). */
  page?: number;
}

export type RenderField =
  'text' | 'color' | 'textColor' | 'fontSize' | 'keyType' | 'bitmap' | 'page';

export interface KeyDiff {
  row: number;
  column: number;
  /** null: the key did not exist in that snapshot. */
  before: DeckKey | null;
  after: DeckKey | null;
  changed: RenderField[];
}

const KEY_FIELDS = ['text', 'color', 'textColor', 'fontSize', 'keyType'] as const;

function bitmapEquals(a: Bitmap | null, b: Bitmap | null): boolean {
  if (a === null || b === null) return a === b;
  return a.format === b.format && a.base64 === b.base64;
}

/** Render fields that differ. `pressed` and `receivedAt` are ignored on purpose (transient). */
export function changedFields(before: DeckKey, after: DeckKey): RenderField[] {
  const changed: RenderField[] = [];
  for (const field of KEY_FIELDS) {
    if (before[field] !== after[field]) changed.push(field);
  }
  if (!bitmapEquals(before.bitmap, after.bitmap)) changed.push('bitmap');
  if (before.location.page !== after.location.page) changed.push('page');
  return changed;
}

/** Stable identity of what a key shows: location, text, colours, keyType and a hash of the bitmap. */
export function fingerprintKey(key: DeckKey): string {
  const bitmapHash =
    key.bitmap === null
      ? '-'
      : createHash('sha256').update(key.bitmap.format).update(key.bitmap.base64).digest('hex');
  const material = JSON.stringify([
    key.location.page,
    key.location.row,
    key.location.column,
    key.text,
    key.color,
    key.textColor,
    key.fontSize,
    key.keyType,
    bitmapHash,
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export function findKey(snapshot: PageSnapshot, row: number, column: number): DeckKey | null {
  return (
    snapshot.cells.find((cell) => cell.location.row === row && cell.location.column === column) ??
    null
  );
}

/** Keys whose render differs between two snapshots (matched by row/column), ordered by row, column. */
export function diffSnapshots(a: PageSnapshot, b: PageSnapshot): KeyDiff[] {
  const index = (snapshot: PageSnapshot): Map<string, DeckKey> =>
    new Map(snapshot.cells.map((cell) => [`${cell.location.row}/${cell.location.column}`, cell]));
  const left = index(a);
  const right = index(b);
  const names = new Set([...left.keys(), ...right.keys()]);
  const diffs: KeyDiff[] = [];
  for (const name of names) {
    const before = left.get(name) ?? null;
    const after = right.get(name) ?? null;
    const [rowText, columnText] = name.split('/');
    const row = Number(rowText);
    const column = Number(columnText);
    if (before !== null && after !== null) {
      const changed = changedFields(before, after);
      if (changed.length > 0) diffs.push({ row, column, before, after, changed });
    } else {
      // A key that appears or disappears is a change of everything it shows.
      diffs.push({ row, column, before, after, changed: ['text', 'bitmap'] });
    }
  }
  return diffs.sort((x, y) => x.row - y.row || x.column - y.column);
}

export interface DeckLayout {
  deviceId: string;
  keysTotal: number;
  keysPerRow: number;
  bitmapSize: number | null;
  /** Format actually requested after negotiation (null: no bitmaps requested). */
  bitmapFormat: BitmapFormat | null;
}

type Waiter = () => void;

/**
 * State of one virtual surface. Fed by the client with the server messages of its DEVICEID. KEY-STATE arrive
 * unordered and can arrive late after a page change (measured), so the deck keeps the latest KEY-STATE per key
 * index and `snapshotPage` filters by `LOCATION` and waits for quiet.
 */
export class VirtualDeck {
  readonly deviceId: string;
  readonly keysTotal: number;
  readonly keysPerRow: number;
  readonly rows: number;
  readonly bitmapSize: number | null;
  readonly bitmapFormat: BitmapFormat | null;
  brightness: number | null = null;
  locked = false;
  lockedCharacterCount: number | null = null;
  /** KEY-STATE without key index or LOCATION (cannot be placed). */
  ignoredStates = 0;

  #keys = new Map<number, DeckKey>();
  #lastUpdateAt = 0;
  #connected = true;
  #disconnectError: SatelliteError | null = null;
  #waiters = new Set<Waiter>();
  #now: () => number;

  constructor(layout: DeckLayout, now: () => number = Date.now) {
    this.deviceId = layout.deviceId;
    this.keysTotal = layout.keysTotal;
    this.keysPerRow = layout.keysPerRow;
    this.rows = Math.ceil(layout.keysTotal / layout.keysPerRow);
    this.bitmapSize = layout.bitmapSize;
    this.bitmapFormat = layout.bitmapFormat;
    this.#now = now;
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** Applies a server message if it belongs to this device. Returns true when it was consumed. */
  apply(message: ServerMessage): boolean {
    switch (message.type) {
      case 'key-state': {
        if (message.deviceId !== this.deviceId) return false;
        if (message.key === null || message.location === null) {
          this.ignoredStates++;
          return true;
        }
        this.#keys.set(message.key, {
          key: message.key,
          location: message.location,
          text: message.text ?? '',
          color: message.color,
          textColor: message.textColor,
          fontSize: message.fontSize,
          keyType: message.keyType,
          pressed: message.pressed,
          bitmap: message.bitmap,
          receivedAt: this.#now(),
        });
        this.#lastUpdateAt = this.#now();
        break;
      }
      case 'brightness':
        if (message.deviceId !== this.deviceId) return false;
        this.brightness = message.value;
        break;
      case 'locked-state':
        if (message.deviceId !== this.deviceId) return false;
        this.locked = message.locked;
        this.lockedCharacterCount = message.characterCount;
        this.#lastUpdateAt = this.#now();
        break;
      case 'keys-clear':
        if (message.deviceId !== this.deviceId) return false;
        this.#keys.clear();
        this.#lastUpdateAt = this.#now();
        break;
      default:
        return false;
    }
    this.#notify();
    return true;
  }

  /** Called by the client when the connection is gone or the device was removed. Rejects waiters. */
  markDisconnected(error: SatelliteError): void {
    this.#connected = false;
    this.#disconnectError = error;
    this.#notify();
  }

  #notify(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }

  /**
   * Resolves true on the next deck update, false after `timeoutMs`; rejects when the connection is lost.
   */
  waitForUpdate(timeoutMs: number): Promise<boolean> {
    if (!this.#connected) return Promise.reject(this.#disconnectError ?? lost());
    return new Promise<boolean>((resolve, reject) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        if (!this.#connected) reject(this.#disconnectError ?? lost());
        else resolve(value);
      };
      const waiter: Waiter = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      this.#waiters.add(waiter);
    });
  }

  /** Latest KEY-STATE per key, grouped to the chosen page. No waiting. */
  peekSnapshot(page?: number): PageSnapshot {
    const all = [...this.#keys.values()];
    let chosen: number | null = page ?? null;
    if (chosen === null && all.length > 0) {
      const counts = new Map<number, { count: number; latest: number }>();
      for (const key of all) {
        const entry = counts.get(key.location.page) ?? { count: 0, latest: 0 };
        entry.count++;
        entry.latest = Math.max(entry.latest, key.receivedAt);
        counts.set(key.location.page, entry);
      }
      // Dominant page; ties go to the page with the most recent KEY-STATE.
      chosen =
        [...counts.entries()].sort(
          (x, y) => y[1].count - x[1].count || y[1].latest - x[1].latest,
        )[0]?.[0] ?? null;
    }
    const cells = all
      .filter((key) => key.location.page === chosen)
      .sort((x, y) => x.location.row - y.location.row || x.location.column - y.location.column);
    const rows = cells.map((cell) => cell.location.row);
    const columns = cells.map((cell) => cell.location.column);
    const originRow = rows.length > 0 ? Math.min(...rows) : 0;
    const originColumn = columns.length > 0 ? Math.min(...columns) : 0;
    const height = rows.length > 0 ? Math.max(...rows) - originRow + 1 : 0;
    const width = columns.length > 0 ? Math.max(...columns) - originColumn + 1 : 0;
    const grid: Array<Array<DeckKey | null>> = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => null),
    );
    for (const cell of cells) {
      const line = grid[cell.location.row - originRow];
      if (line) line[cell.location.column - originColumn] = cell;
    }
    const staleCells = all.length - cells.length;
    return {
      deviceId: this.deviceId,
      page: chosen,
      takenAt: this.#now(),
      cells,
      grid,
      originRow,
      originColumn,
      staleCells,
      complete: cells.length === this.keysTotal && staleCells === 0,
      locked: this.locked,
      brightness: this.brightness,
    };
  }

  /** Latest drawn key at the Companion location row/column on the dominant (or given) page, if any. */
  getKey(row: number, column: number, page?: number): DeckKey | null {
    return findKey(this.peekSnapshot(page), row, column);
  }

  /**
   * Waits until no KEY-STATE arrived for `quietMs` (and, with `page`, until every key shows that page), then
   * returns the grid. Rejects with `SNAPSHOT_TIMEOUT` after `timeoutMs` (nothing arrived, or constant activity).
   */
  async snapshotPage(options: SnapshotOptions = {}): Promise<PageSnapshot> {
    const quietMs = options.quietMs ?? 150;
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(quietMs) || quietMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new SatelliteError('INVALID_ARGUMENT', 'quietMs must be >= 0 and timeoutMs > 0');
    }
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      if (!this.#connected) throw this.#disconnectError ?? lost();
      const now = this.#now();
      const snapshot = this.peekSnapshot(options.page);
      const onPage =
        options.page === undefined || (snapshot.cells.length > 0 && snapshot.staleCells === 0);
      const quietFor = now - this.#lastUpdateAt;
      if (this.#keys.size > 0 && onPage && quietFor >= quietMs) return snapshot;
      const remaining = deadline - now;
      if (remaining <= 0) {
        throw new SatelliteError(
          'SNAPSHOT_TIMEOUT',
          this.#keys.size === 0
            ? `No KEY-STATE received within ${timeoutMs} ms`
            : `Page did not settle within ${timeoutMs} ms (cells: ${snapshot.cells.length}, stale: ${snapshot.staleCells})`,
        );
      }
      const wake =
        this.#keys.size > 0 && onPage ? Math.min(remaining, quietMs - quietFor) : remaining;
      await this.waitForUpdate(wake);
    }
  }
}

function lost(): SatelliteError {
  return new SatelliteError('CONNECTION_LOST', 'The device is no longer connected');
}
