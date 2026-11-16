import { describe, expect, it } from 'vitest';
import {
  diffSnapshots,
  fingerprintKey,
  SatelliteError,
  VirtualDeck,
  parseServerLine,
} from '../../src/satellite/index.js';

const b64 = (text: string): string => Buffer.from(text).toString('base64');

function state(
  key: number,
  page: number,
  options: { text?: string; color?: string; pressed?: boolean; deviceId?: string } = {},
): string {
  const row = Math.floor(key / 8);
  const column = key % 8;
  return (
    `KEY-STATE DEVICEID="${options.deviceId ?? 'deck'}" KEY=${key} LOCATION="${page}/${row}/${column}" ` +
    `PRESSED=${options.pressed ? 1 : 0} TYPE="BUTTON" COLOR="${options.color ?? '#000000'}" TEXTCOLOR="#000000" ` +
    `TEXT="${b64(options.text ?? '')}" FONT_SIZE="auto"`
  );
}

function newDeck(): VirtualDeck {
  return new VirtualDeck({
    deviceId: 'deck',
    keysTotal: 32,
    keysPerRow: 8,
    bitmapSize: null,
    bitmapFormat: null,
  });
}

function feed(deck: VirtualDeck, lines: string[]): void {
  for (const line of lines) deck.apply(parseServerLine(line));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('VirtualDeck', () => {
  it('builds a grid from unordered KEY-STATE and addresses keys by row/column', async () => {
    const deck = newDeck();
    const order = [2, 3, 0, 4, 1, ...Array.from({ length: 27 }, (_, i) => i + 5)];
    feed(
      deck,
      order.map((key) =>
        state(
          key,
          1,
          key === 0 ? { text: 'SET', color: '#00ff00' } : key === 9 ? { text: 'N' } : {},
        ),
      ),
    );
    const snapshot = await deck.snapshotPage({ quietMs: 20, timeoutMs: 1000 });
    expect(snapshot.page).toBe(1);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.cells).toHaveLength(32);
    expect(snapshot.grid).toHaveLength(4);
    expect(snapshot.grid[0]).toHaveLength(8);
    expect(snapshot.cells[0]?.key).toBe(0);
    expect(deck.getKey(0, 0)).toMatchObject({ text: 'SET', color: '#00ff00', key: 0 });
    expect(deck.getKey(1, 1)).toMatchObject({ text: 'N', key: 9 });
    expect(deck.getKey(7, 7)).toBeNull();
  });

  it('ignores KEY-STATE of other devices', () => {
    const deck = newDeck();
    expect(deck.apply(parseServerLine(state(0, 1, { deviceId: 'other' })))).toBe(false);
    expect(deck.peekSnapshot().cells).toHaveLength(0);
  });

  it('waits for quiet: a late KEY-STATE after a page change is still included', async () => {
    const deck = newDeck();
    feed(
      deck,
      Array.from({ length: 32 }, (_, i) => state(i, 1)),
    );
    // page 2 arrives; the last key comes 80 ms late
    feed(
      deck,
      Array.from({ length: 31 }, (_, i) => state(i, 2, i === 0 ? { text: 'P2' } : {})),
    );
    setTimeout(() => deck.apply(parseServerLine(state(31, 2))), 80);

    const early = deck.peekSnapshot(2);
    expect(early.staleCells).toBe(1);
    expect(early.complete).toBe(false);

    const snapshot = await deck.snapshotPage({ page: 2, quietMs: 30, timeoutMs: 1000 });
    expect(snapshot.page).toBe(2);
    expect(snapshot.staleCells).toBe(0);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.cells.every((cell) => cell.location.page === 2)).toBe(true);
  });

  it('filters by LOCATION: a stale page-1 state arriving after page 2 does not win the majority', () => {
    const deck = newDeck();
    feed(
      deck,
      Array.from({ length: 32 }, (_, i) => state(i, 2)),
    );
    feed(deck, [state(5, 1)]);
    const snapshot = deck.peekSnapshot();
    expect(snapshot.page).toBe(2);
    expect(snapshot.staleCells).toBe(1);
    expect(snapshot.complete).toBe(false);
  });

  it('rejects with SNAPSHOT_TIMEOUT when nothing arrives or the page never completes', async () => {
    const deck = newDeck();
    await expect(deck.snapshotPage({ quietMs: 10, timeoutMs: 60 })).rejects.toMatchObject({
      code: 'SNAPSHOT_TIMEOUT',
    });
    feed(deck, [state(0, 1)]);
    await expect(deck.snapshotPage({ page: 2, quietMs: 10, timeoutMs: 60 })).rejects.toMatchObject({
      code: 'SNAPSHOT_TIMEOUT',
    });
  });

  it('keeps waiting while states keep arriving', async () => {
    const deck = newDeck();
    feed(deck, [state(0, 1)]);
    const ticker = setInterval(() => deck.apply(parseServerLine(state(1, 1))), 10);
    await expect(deck.snapshotPage({ quietMs: 100, timeoutMs: 150 })).rejects.toBeInstanceOf(
      SatelliteError,
    );
    clearInterval(ticker);
    await expect(deck.snapshotPage({ quietMs: 50, timeoutMs: 500 })).resolves.toBeDefined();
  });

  it('rejects waiters when the device is disconnected', async () => {
    const deck = newDeck();
    const waiting = deck.snapshotPage({ timeoutMs: 1000 });
    await sleep(10);
    deck.markDisconnected(new SatelliteError('CONNECTION_LOST', 'gone'));
    await expect(waiting).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    await expect(deck.waitForUpdate(10)).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  it('tracks brightness, lock state and KEYS-CLEAR', () => {
    const deck = newDeck();
    feed(deck, [
      'BRIGHTNESS DEVICEID="deck" VALUE=37',
      'LOCKED-STATE DEVICEID="deck" LOCKED=1 CHARACTER_COUNT=0 ROTATION=0',
      state(0, 1),
    ]);
    expect(deck.brightness).toBe(37);
    expect(deck.locked).toBe(true);
    expect(deck.peekSnapshot().locked).toBe(true);
    feed(deck, ['KEYS-CLEAR DEVICEID="deck"']);
    expect(deck.peekSnapshot().cells).toHaveLength(0);
  });

  it('counts KEY-STATE without LOCATION as ignored', () => {
    const deck = newDeck();
    feed(deck, ['KEY-STATE DEVICEID="deck" KEY=0 PRESSED=0']);
    expect(deck.ignoredStates).toBe(1);
    expect(deck.peekSnapshot().cells).toHaveLength(0);
  });
});

describe('diffSnapshots and fingerprintKey', () => {
  it('reports changed keys, ignores the transient pressed flag', () => {
    const deck = newDeck();
    feed(deck, [state(0, 1, { text: 'SET', color: '#00ff00' }), state(1, 1, { text: 'RESET' })]);
    const a = deck.peekSnapshot();
    feed(deck, [state(0, 1, { text: 'SET', color: '#00ff00', pressed: true })]);
    expect(diffSnapshots(a, deck.peekSnapshot())).toEqual([]);
    feed(deck, [state(0, 1, { text: 'SET', color: '#ff0000' }), state(2, 1, { text: 'NEW' })]);
    const diffs = diffSnapshots(a, deck.peekSnapshot());
    expect(diffs.map((d) => [d.row, d.column, d.changed])).toEqual([
      [0, 0, ['color']],
      [0, 2, ['text', 'bitmap']],
    ]);
  });

  it('detects bitmap-only changes and fingerprints differ with them', () => {
    const deck = newDeck();
    const withBitmap = (b64Bitmap: string): string =>
      `${state(0, 1, { text: 'X' })} BITMAP="${b64Bitmap}"`;
    feed(deck, [withBitmap('AAAA')]);
    const a = deck.peekSnapshot();
    const keyA = a.cells[0];
    feed(deck, [withBitmap('AAAB')]);
    const b = deck.peekSnapshot();
    expect(diffSnapshots(a, b)[0]?.changed).toEqual(['bitmap']);
    expect(fingerprintKey(keyA!)).not.toBe(fingerprintKey(b.cells[0]!));
    expect(fingerprintKey(keyA!)).toBe(fingerprintKey({ ...keyA!, receivedAt: 0, pressed: true }));
  });
});
