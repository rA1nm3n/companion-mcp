# MCP tools

The server speaks MCP over **stdio** (`dist/cli.js`). All tools are prefixed `companion_`. Verified against Bitfocus Companion **5.1.3** (built from source, dev mode); see `docs/architecture.md` for the measured facts behind the design.

## Result format

Every tool returns one text content item with JSON.

```jsonc
{ "ok": true, "...": "tool specific fields" }
{ "ok": false, "code": "WRITE_DISABLED", "message": "...", "source": "safety", "...": "context, e.g. snapshot" }
```

- `ok: false` results also set `isError: true`. They never contain a stack trace or a token.
- `source` is one of `safety`, `transport`, `satellite`, `config`, `input`, `validation`, `internal`. Codes come from `SafetyError` (`WRITE_DISABLED`, `HOST_NOT_ALLOWED`, `SNAPSHOT_INVALID`, ...), `TransportError` (`VERSION_UNSUPPORTED`, `CONNECT_FAILED`, `REMOTE_ERROR`, ...), `SatelliteError` (`SNAPSHOT_TIMEOUT`, `KEY_CHANGED`, `KEY_NOT_FOUND`, `SURFACE_LOCKED`, ...) or the tools (`VALIDATION_FAILED`, `READBACK_MISMATCH`, `REST_TOKEN_MISSING`, ...).
- Arguments that violate the input schema (unknown key, wrong type, out of range) are rejected by the MCP SDK before the tool runs. That answer is `isError: true` with a plain text message, not the JSON above.

## Tools

| Tool                           | Purpose                                                                     | Side effects                                                 | Gate                                             |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `companion_catalog_search`     | Search the offline module catalog                                           | none (offline)                                               | none                                             |
| `companion_catalog_module`     | Actions and feedbacks of one module                                         | none (offline)                                               | none                                             |
| `companion_catalog_action`     | Full definition of one action or feedback (options, choices, ranges)        | none (offline)                                               | none                                             |
| `companion_validate_config`    | Validate an export against the format rules and the catalog                 | none (offline)                                               | none                                             |
| `companion_generate_page`      | Page from a template (`atem`, `videohub`, `vmix`, `birddog`), validated     | none (offline)                                               | none                                             |
| `companion_build_page`         | Page from a free specification (buttons, actions, feedbacks), validated     | none (offline)                                               | none                                             |
| `companion_status`             | Reachability, version, REST state, safety configuration (no tokens)         | short read-only connection                                   | host allow-list (nothing is contacted otherwise) |
| `companion_export`             | Export `full` configuration or `{ page: n }`                                | read-only                                                    | host allow-list, version guard                   |
| `companion_get_page`           | Read a page back (name and every control)                                   | read-only                                                    | host allow-list, version guard                   |
| `companion_list_connections`   | Connections via REST v2 (secret-looking fields redacted)                    | read-only                                                    | host allow-list; needs `COMPANION_REST_TOKEN`    |
| `companion_list_surfaces`      | Surfaces via REST v2                                                        | read-only                                                    | host allow-list; needs `COMPANION_REST_TOKEN`    |
| `companion_import_page`        | Validate, snapshot, import, read back, diff. `dry_run` defaults to **true** | **replaces a page** (or appends); may **create connections** | write gate, host allow-list, version guard       |
| `companion_rollback`           | Re-import a snapshot of a page. `dry_run` defaults to **true**              | **replaces a page**; may re-create missing connections       | write gate, host allow-list, version guard       |
| `companion_satellite_snapshot` | Read what every button of the shown page renders (text, color, bitmap)      | registers a virtual surface for the call, removes it again   | host allow-list                                  |
| `companion_press`              | Press one button. `dry_run` defaults to **true**                            | **a real press triggers the button's actions**               | write gate, host allow-list, press allow-list    |

Triggers and full imports are intentionally not implemented.

### `companion_generate_page`

`template` plus `params`. All templates take `connection: { label, id?, updatePolicy? }` (`id` defaults to the label) and the optional `pageName`, `navigation`, `oldPageNumber`, `notes`. Colors are RGB integers (`0xff0000` = `16711680`).

| Template   | Params                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atem`     | `inputs` (count or list of numbers or `{ input, label }`), `mixEffect?`, `programColor?`, `previewColor?`, `programTextColor?`, `previewTextColor?`, `transitions?`, `columns?`  |
| `videohub` | `inputs`, `outputs`, `routedColor?`, `routedTextColor?`, `labelColor?`, `ignoreLock?`                                                                                            |
| `vmix`     | `inputs` (count or list of number, name or `{ input, label }`), `mix?` (1 to 16 or `"Selected"`), `programColor?`, `previewColor?`, `tallyTextColor?`, `programRow?`, `columns?` |
| `birddog`  | `presets` (count or list, 1 to 64), `buttonColor?`, `columns?`                                                                                                                   |

Invalid params come back as `ok: false`, `code: INVALID_PARAMS` with an `errors` list.

### `companion_build_page`

```jsonc
{
  "pageName": "Cameras",
  "connections": [{ "label": "atem", "moduleId": "bmd-atem" }],
  "buttons": [
    {
      "row": 0,
      "column": 0,
      "text": "CAM 1",
      "colors": { "background": 3355443, "text": 16777215 },
      "actions": [
        { "connection": "atem", "actionId": "program", "options": { "mixeffect": 1, "input": 1 } },
      ],
      "feedbacks": [
        {
          "connection": "atem",
          "feedbackId": "program",
          "options": { "mixeffect": 1, "input": 1 },
          "style": { "bgColor": 16711680 },
        },
      ],
    },
  ],
}
```

Rows and columns are 0-based. Actions and feedbacks reference a connection by its label, or `"internal"` for Companion's own actions. Option values are plain values (wrapped as `{ isExpression: false, value }`) or already wrapped objects for expressions. Look up action and option ids with `companion_catalog_action`; the validator rejects unknown actions and out of range values. The export is always returned, together with `errors` and `warnings`.

### `companion_import_page`

1. Validate the export (`validateExport` with the catalog). Errors abort before anything else (`VALIDATION_FAILED`).
2. Host allow-list. With `dry_run: true` (default) the tool returns the plan and the gates that would block the real run. **No connection to Companion is made.**
3. With `dry_run: false`: write gate, then one Companion connection for all steps. Snapshot of the target page (export plus SHA-256 checksum), upload and import, read back with `getPage`, diff against the intended page.
4. `ok` is true only if the diff has no error. A control that Companion dropped silently is `READBACK_MISMATCH`. The result then still carries `snapshot` so the change can be undone.

Result fields of an applied import: `target_page` (resolved, also for `-1`), `readback` (`ok`, `summary`, `deviations`), `snapshot` (`null` when appending), `rollback` (hint), `created_connections`, `warnings`.

Behaviors measured on Companion 5.1.3 that you should know about:

- An unmapped connection of the file is **created as a new connection** on every import (`atem`, then `atem_2`, ...). Pass `connection_mapping: { "<id in file>": "<existing connection id>" }` to reuse one. The dry run warns about every unmapped connection; `created_connections` lists what an applied import created.
- Companion assigns new ids to entities and remaps `connectionId`; entities of module connections come back without an empty `children` object. The read-back diff (`diffReadback`) handles exactly these differences itself: the tool passes the remapping of the import as `connectionIdMap` (a different id than the mapped one is an error) and an absent `children` equals an empty one. Everything else is reported.
- Imports are serialized inside the server (Companion allows one upload session at a time); parallel calls wait for each other.
- Appending (`target_page: -1`) has no snapshot. Undo it by deleting the page in Companion.

### `companion_rollback`

Takes the `snapshot` object exactly as returned by `companion_import_page`. The checksum is verified first (a modified snapshot is `SNAPSHOT_INVALID`); a snapshot taken on another host is refused (`SNAPSHOT_HOST_MISMATCH`). The applied rollback exports the current page first (`pre_rollback_snapshot`, so the rollback can be undone), re-imports the snapshot into the same page number, reusing connections that still exist, and reads back.

### `companion_satellite_snapshot`

Connects as a virtual Stream Deck through the Satellite API (TCP, default port `16622`), waits for a quiet and complete page and returns the grid. Read-only.

| Input                    | Default                               | Meaning                                                                             |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `host`, `port`           | host of `COMPANION_URL`, 16622        | Satellite target; the host must be on the allow-list (checked before connecting).   |
| `deck`                   | `{ keys_total: 32, keys_per_row: 8 }` | Geometry of the virtual surface; only keys inside it are visible.                   |
| `page_hint`              | unset                                 | Wait until all keys belong to this page. It does **not** switch the page.           |
| `quiet_ms`, `timeout_ms` | 300, 10000                            | Silence required after the last update; budget for connecting and for the snapshot. |
| `include_bitmaps`        | `false`                               | Adds `bitmap: { format, base64 }` per key (includes Companion's top bar).           |

Result: `page`, `complete`, `locked`, `deck`, `keys` (`row`, `column`, `key`, `text`, `color`, `text_color`, `font_size`, `key_type`, `empty`, `fingerprint`, optional `bitmap`) and `warnings`. The `fingerprint` ignores bitmaps and can be passed to `companion_press` as `expect_fingerprint`.

The surface starts on **page 1** and keeps its last page when the same device id reconnects. Choosing a page from outside is not implemented (it needs Companion internals); use a page navigation key. The device id is fixed (`mcp-virtual-deck`): Companion keeps one permanent surface entry for it. Calls are serialized because they share that id.

### `companion_press`

Takes `row` and `column` (0-based Companion coordinates on the page the surface shows), `dry_run` (default **true**), optional `expect_fingerprint`, and the connection inputs of the snapshot plus `change_timeout_ms` (default 2000).

1. Dry run: reads the key and returns the plan (`current`, `fingerprint`, `empty`, `locked`, `gate`, `would_send`, `would_be_allowed`). Nothing is sent, and a closed gate is shown in `gate` instead of failing.
2. Real press (`dry_run: false`): write gate and host allow-list are checked **before** any connection; then the key is read, a locked surface is refused, the press allow-list is checked for the key's `page/row/column`, `expect_fingerprint` is compared (`KEY_CHANGED` on a difference) and KEY-PRESS down and up are sent.
3. Result: `accepted` (Companion answered OK), `render_changed`, `target_changed`, `page_changed`, `changes`, `before`, `after`. `accepted` is also true for empty keys and `render_changed` can be a false positive on live buttons; **neither proves the intended effect**. Verify that independently (for example a custom variable).

Refusals and failures are `ok: false` with `code`, `message` and `source` (`safety` for `WRITE_DISABLED`, `HOST_NOT_ALLOWED`, `PRESS_NOT_ALLOWED`; `satellite` for `KEY_CHANGED`, `SNAPSHOT_TIMEOUT`, ...).

**Security note:** the Satellite ports of Companion (`16622` TCP, `16623` WebSocket) listen on `0.0.0.0` (or `::`) **without authentication**, even if the admin address is `127.0.0.1`, and cannot be disabled. Anyone who can reach them can read and press buttons. Keep them behind a firewall or a separate network segment and never expose them to an untrusted network. This server only talks to allow-listed hosts and never uses subscriptions (see `docs/satellite.md`).

## Configuration

| Variable                              | Default                   | Meaning                                                                                   |
| ------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `COMPANION_URL`                       | `http://127.0.0.1:8000`   | Base URL of Companion. Credentials and path are dropped.                                  |
| `COMPANION_REST_TOKEN`                | unset                     | REST v2 token (`cpn_...`); only for `list_connections` and `list_surfaces`. Never output. |
| `COMPANION_MCP_ALLOW_UNKNOWN_VERSION` | `0`                       | `1`/`true` accepts Companion versions other than 5.1.x (the tRPC API is internal).        |
| `COMPANION_MCP_WRITE`                 | `0`                       | `1`/`true` enables `import_page`, `rollback` and `press` with `dry_run: false`.           |
| `COMPANION_MCP_ALLOWED_HOSTS`         | `127.0.0.1,localhost,::1` | Comma separated hosts the server may contact. Ports are ignored.                          |
| `COMPANION_MCP_PRESS_ALLOW`           | unset                     | `page/row/column` list; if set, `companion_press` only presses listed buttons.            |

An invalid environment stops the server with a message on stderr and exit code 1. Diagnostics go to stderr only; stdout belongs to the protocol.

## Client configuration

The package is not published yet, so run the built file with `node`. Build once: `npm ci && npm run build`.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "companion": {
      "command": "node",
      "args": ["/absolute/path/to/companion-mcp/dist/cli.js"],
      "env": {
        "COMPANION_URL": "http://127.0.0.1:8000"
      }
    }
  }
}
```

Claude Code:

```sh
claude mcp add companion -e COMPANION_URL=http://127.0.0.1:8000 -- node /absolute/path/to/companion-mcp/dist/cli.js
```

Writes stay off until you add `COMPANION_MCP_WRITE=1` (and, for a Companion on another machine, `COMPANION_MCP_ALLOWED_HOSTS=<host>`). Use a throw-away Companion instance while trying things out.

## Typical flow

1. `companion_catalog_search` / `companion_catalog_module` / `companion_catalog_action`: find the module and the exact action and option ids.
2. `companion_generate_page` (templates) or `companion_build_page` (free form). The result already contains the validation.
3. `companion_validate_config` after any manual change to the export.
4. `companion_status`: check version, write gate and host.
5. `companion_import_page` with `dry_run: true` (default): read the plan and the connection warnings.
6. `companion_import_page` with `dry_run: false`, `target_page` and, if the connection exists, `connection_mapping`. Keep the returned `snapshot`.
7. `companion_get_page`: independent read-back; `ok` of the import already includes the diff.
8. `companion_rollback` with the snapshot (dry run first), if the result is not what you want.

Import, look, press:

1. `companion_import_page` (`dry_run: false`) imports the page; `readback.ok` confirms what Companion stored.
2. `companion_satellite_snapshot` shows what the buttons render; take the `fingerprint` of the key.
3. `companion_press` with `row`, `column` and `expect_fingerprint` as a dry run: check `gate`, `current` and `would_be_allowed`.
4. `companion_press` with `dry_run: false` (needs `COMPANION_MCP_WRITE=1`): read `accepted`, `render_changed`, `target_changed`, then verify the effect independently. Only press on equipment you may operate.

## Tests

`npm test` runs the tools against an in-memory MCP client and a fake Companion built on the shared mock WebSocket server. With `COMPANION_TEST_URL` set (a **throw-away** Companion 5.1.x), `test/tools/integration.test.ts` additionally runs `generate_page(atem)`, `import_page`, `get_page` and `rollback` against the real instance; it replaces page 1 and restores it, and the ATEM page adds a connection. The satellite tools are tested against the mock Satellite server of `test/satellite`; with `COMPANION_TEST_URL` and `COMPANION_TEST_SATELLITE_PORT` (for example `16622`) set, `test/tools/satellite-integration.test.ts` imports the ATEM template, takes a snapshot and checks the press plan and gates on it (no real press on ATEM keys), then presses a key with an Internal action on a test page. Run the integration files one after another (`--no-file-parallelism`); they share page 1.
