# Satellite client (`src/satellite`)

Verified against Bitfocus Companion **5.1.3** (Satellite API **1.14.0**), measured on a headless build. The code is
derived from those measurements; where it deviates from the web documentation, 5.1.3 wins.

## Purpose

A Companion instance can only be read back through its rendered surfaces. The Satellite API lets us register a
**virtual surface** (a Stream Deck without hardware) and then:

- read what every button on a page currently shows (text, colours, bitmap),
- press a button and check whether its look changed.

This complements the offline config builders (`src/format`) and the tRPC/REST transport: after importing a page, the
satellite client can confirm what Companion actually renders.

The client never changes configuration. A press is a write action and goes through the safety gate.

## Protocol quick reference

Transport: TCP port **16622** (plain text, one command per line) or WebSocket port **16623** (one text frame per
message, still line based). Both ports are fixed in Companion 5.1.3.

Line format: `COMMAND [OK|ERROR] KEY=VALUE KEY="value with spaces" ...`

- Parsing follows Companion: a space separates tokens outside quotes, `"` toggles protection and is removed, `\` escapes
  the next character, the first `=` splits (Base64 padding survives).
- The server writes numbers unquoted and strings quoted without escaping: `FONT_SIZE=21.1` but `FONT_SIZE="auto"`.
  The server does not escape `"` in echoed values, so DEVICEIDs are restricted to `[A-Za-z0-9_-]`.
- There are no request IDs. Answers are matched by command and `DEVICEID`.

| Direction | Message                                                                                                               | Notes                          |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| server    | `BEGIN CompanionVersion=".." ApiVersion="1.14.0"`, `CAPS SUBSCRIPTIONS=0 BITMAP_FORMATS="rgb,png,webp" ...`           | sent immediately after connect |
| client    | `ADD-DEVICE DEVICEID PRODUCT_NAME KEYS_TOTAL KEYS_PER_ROW [BITMAPS] COLORS="hex" TEXT=1 TEXT_STYLE=1 [BITMAP_FORMAT]` | default 8x4 = 32 keys          |
| server    | `ADD-DEVICE OK`, `BRIGHTNESS`, then one `KEY-STATE` per key                                                           | unordered                      |
| server    | `KEY-STATE DEVICEID KEY LOCATION="page/row/column" PRESSED TYPE COLOR TEXTCOLOR TEXT FONT_SIZE [BITMAP]`              | `TEXT` is Base64 UTF-8         |
| client    | `KEY-PRESS DEVICEID KEY PRESSED=1` / `PRESSED=0`                                                                      | answered with `KEY-PRESS OK`   |
| client    | `PING [payload]`                                                                                                      | answered with `PONG payload`   |
| client    | `REMOVE-DEVICE`, `QUIT`                                                                                               | clean shutdown                 |
| server    | `LOCKED-STATE`, `KEYS-CLEAR`, `ERROR MESSAGE="..."`                                                                   |                                |

Mapping: legacy key `N` with `KEYS_PER_ROW=k` sits at row `N / k`, column `N % k`. The `LOCATION` of each `KEY-STATE`
names the Companion button shown (page, row, column). The client indexes by `LOCATION`, not by the key index.

Measured behaviour the client relies on:

- `KEY-STATE` arrive **unordered** and, after a page change, can arrive **late** (a 15-key page was complete after
  about 735 ms). `snapshotPage` therefore waits for quiet and can wait until every key shows a given page.
- Companion drops a client after **5 s without data** and never sends `PING` itself. The client sends `PING` every
  2 s (configurable, maximum 4999 ms) and treats an unanswered `PING` as a dead connection (`PONG_TIMEOUT`).
- A new surface starts on **page 1**. Choosing another page from outside is only possible through the internal tRPC
  (`surfaces.groupSetConfigKey` with `last_page_id`, value is the page **ID**), or by pressing a page navigation key
  on the surface. That is not part of this module.
- `TEXT` is the plain button text. The bitmap additionally contains Companion's topbar (about the top 14 px).
  Bitmaps are kept as Base64 bytes plus format (`rgb`, `png`, `webp`); this module does not decode them.
- Unknown commands are answered with `ERROR MESSAGE="Unknown command: X"`. The web documentation also lists API 1.15
  and 1.16 commands (`DEVICE-APPEARANCE`, `BITMAP-CACHE`); 5.1.3 does not know them, they are **not implemented**, and
  unknown lines are tolerated (`onUnknown`) instead of failing.

## Safety

Read this before enabling anything.

1. **The Satellite ports listen on all interfaces without authentication** (`0.0.0.0` or `::`), even when the admin
   address is `127.0.0.1`. They cannot be disabled or moved. There is no token, no PIN at connect time, and the
   WebSocket accepts any `Origin`. Protect them with a firewall or network segment; never expose 16622/16623 to the
   internet or a guest network. mDNS announces them by default.
2. **The client only talks to hosts on the allow-list** (`COMPANION_MCP_ALLOWED_HOSTS`, default loopback), checked with
   `assertHostAllowed` before any socket is opened. It never discovers hosts (no mDNS).
3. **Subscriptions are never used.** `ADD-SUB`/`SUB-PRESS` bypass the PIN lock and can read and press any button.
   The client cannot produce those commands (see `ClientCommand`). If `CAPS SUBSCRIPTIONS=1`, `connect` returns a
   warning in `HandshakeInfo.warnings`. It also never sends `SET-VARIABLE-VALUE`, `CHANGE-PAGE`, `CONFIG_FIELDS` or
   `FIRMWARE-UPDATE-INFO`.
4. **`OK` is not proof.** Companion answers `KEY-PRESS OK` for empty keys, locked surfaces and ignored page changes
   (all measured). `pressVerified` therefore reports only two levels: `accepted` (server said OK) and
   `render_changed` (a different look arrived). Neither proves the intended effect; verify that independently (for
   example a custom variable over HTTP, as the integration test does).
5. **A press is a write.** `pressVerified` and `SatelliteClient.keyPress` call `assertPressAllowed`: write flag
   (`COMPANION_MCP_WRITE=1`), allowed host, and `COMPANION_MCP_PRESS_ALLOW` if set. The release (`PRESSED=0`) is
   never gated and is always sent once a press was started.
6. **Read before press.** The key is read right before the press. A locked surface (`LOCKED-STATE` or the lock icon
   as text) is refused. `expectFingerprint` binds a press to an earlier read; if the key looks different now (for
   example an operator switched the page), the press is refused with `KEY_CHANGED`.
7. **Each new DEVICEID creates a permanent surface entry in Companion.** The default is the fixed id
   `mcp-virtual-deck`; use a fixed id of your own, not one per session.
8. **No silent reconnect.** After a loss the state is `disconnected`, pending requests and decks fail with
   `CONNECTION_LOST`, and the caller must call `connect` and `addDevice` again.

## Modules

| File           | Content                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol.ts`  | line parser/serializer, typed server messages and client commands, version comparison                                                                   |
| `transport.ts` | TCP and WebSocket line transports, line splitter with length limit                                                                                      |
| `client.ts`    | `SatelliteClient`: state machine `disconnected / connecting / ready / closing`, handshake, PING, `addDevice`, `removeDevice`, gated `keyPress`, `close` |
| `deck.ts`      | `VirtualDeck`: key state by `LOCATION`, `snapshotPage`, `getKey`, `diffSnapshots`, `fingerprintKey`                                                     |
| `press.ts`     | `planPress` (dry run) and `pressVerified`                                                                                                               |
| `errors.ts`    | `SatelliteError` with a `code` (safety refusals stay `SafetyError`)                                                                                     |

## Limits

- Only the legacy layout (`KEYS_TOTAL`, `KEYS_PER_ROW`) is implemented, not the `LAYOUT_MANIFEST` mode.
- `KEY-ROTATE` can be serialized but has no client method (only the `OK` was measured, not the effect).
- Page selection is not implemented (internal tRPC, see above). A new surface shows page 1.
- `renderChanged` is true if **any** key of the page changed after the press (a feedback can recolour other keys).
  `targetChanged` tells whether the pressed key itself changed. Clocks or other live buttons can cause false positives.
- Not measured: surfaces larger than the page grid, PIN lock `PARTIAL`, release builds and Docker, several
  simultaneous clients, `LEDS`.
- Bitmaps are not decoded; a bitmap includes the topbar, so compare bitmaps with each other, not with the config.

## Example

```ts
import { loadSafetyConfig } from './safety/index.js';
import { SatelliteClient, pressVerified } from './satellite/index.js';

const safety = loadSafetyConfig(process.env); // write flag, allowed hosts, press allow-list
const client = new SatelliteClient({ safety });
try {
  await client.connect('127.0.0.1', 16622, { timeoutMs: 5000 });
  const deck = await client.addDevice({ deviceId: 'mcp-virtual-deck' }); // 8x4, text + colour

  const page = await deck.snapshotPage({ quietMs: 300, timeoutMs: 10_000 });
  console.log(page.page, page.complete, deck.getKey(0, 0)?.text);

  // Plan first: reads the key, checks the gate, sends nothing.
  const plan = await pressVerified(client, deck, 0, 0, { dryRun: true });
  if (plan.gate.allowed && !plan.locked) {
    const result = await pressVerified(client, deck, 0, 0, {
      dryRun: false,
      expectFingerprint: plan.fingerprint,
    });
    console.log(
      result.level,
      result.renderChanged,
      result.changes.map((c) => c.changed),
    );
  }
} finally {
  await client.close(); // REMOVE-DEVICE, QUIT
}
```

## Tests

- `npm test` runs the unit and mock-server tests (`test/satellite/*.test.ts`). The mock server replays the measured
  wire behaviour (unordered `KEY-STATE`, late page, OK for everything, idle timeout, no server `PING`).
- `test/satellite/integration.test.ts` runs only with `COMPANION_TEST_URL` and `COMPANION_TEST_SATELLITE_PORT` set
  (for example `http://127.0.0.1:8000` and `16622`). It replaces page 1 of that instance and restores it afterwards;
  use a throw-away instance.
