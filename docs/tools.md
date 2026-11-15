# MCP tools

The server speaks MCP over **stdio** (`dist/cli.js`). All tools are prefixed `companion_`. Verified against Bitfocus Companion **5.1.3** (built from source, dev mode); see `docs/architecture.md` for the measured facts behind the design.

## Result format

Every tool returns one text content item with JSON.

```jsonc
{ "ok": true, "...": "tool specific fields" }
{ "ok": false, "code": "WRITE_DISABLED", "message": "...", "source": "safety", "...": "context, e.g. snapshot" }
```

- `ok: false` results also set `isError: true`. They never contain a stack trace or a token.
- `source` is one of `safety`, `transport`, `config`, `input`, `validation`, `internal`. Codes come from `SafetyError` (`WRITE_DISABLED`, `HOST_NOT_ALLOWED`, `SNAPSHOT_INVALID`, ...), `TransportError` (`VERSION_UNSUPPORTED`, `CONNECT_FAILED`, `REMOTE_ERROR`, ...) or the tools (`VALIDATION_FAILED`, `READBACK_MISMATCH`, `REST_TOKEN_MISSING`, ...).
- Arguments that violate the input schema (unknown key, wrong type, out of range) are rejected by the MCP SDK before the tool runs. That answer is `isError: true` with a plain text message, not the JSON above.

## Tools

| Tool                         | Purpose                                                                     | Side effects                                                 | Gate                                             |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `companion_catalog_search`   | Search the offline module catalog                                           | none (offline)                                               | none                                             |
| `companion_catalog_module`   | Actions and feedbacks of one module                                         | none (offline)                                               | none                                             |
| `companion_catalog_action`   | Full definition of one action or feedback (options, choices, ranges)        | none (offline)                                               | none                                             |
| `companion_validate_config`  | Validate an export against the format rules and the catalog                 | none (offline)                                               | none                                             |
| `companion_generate_page`    | Page from a template (`atem`, `videohub`, `vmix`, `birddog`), validated     | none (offline)                                               | none                                             |
| `companion_build_page`       | Page from a free specification (buttons, actions, feedbacks), validated     | none (offline)                                               | none                                             |
| `companion_status`           | Reachability, version, REST state, safety configuration (no tokens)         | short read-only connection                                   | host allow-list (nothing is contacted otherwise) |
| `companion_export`           | Export `full` configuration or `{ page: n }`                                | read-only                                                    | host allow-list, version guard                   |
| `companion_get_page`         | Read a page back (name and every control)                                   | read-only                                                    | host allow-list, version guard                   |
| `companion_list_connections` | Connections via REST v2 (secret-looking fields redacted)                    | read-only                                                    | host allow-list; needs `COMPANION_REST_TOKEN`    |
| `companion_list_surfaces`    | Surfaces via REST v2                                                        | read-only                                                    | host allow-list; needs `COMPANION_REST_TOKEN`    |
| `companion_import_page`      | Validate, snapshot, import, read back, diff. `dry_run` defaults to **true** | **replaces a page** (or appends); may **create connections** | write gate, host allow-list, version guard       |
| `companion_rollback`         | Re-import a snapshot of a page. `dry_run` defaults to **true**              | **replaces a page**; may re-create missing connections       | write gate, host allow-list, version guard       |

Button presses are not part of this server yet. Triggers and full imports are intentionally not implemented.

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
- Companion assigns new ids to entities and remaps `connectionId`; entities of module connections come back without an empty `children` object. The read-back diff compensates for exactly these two differences and reports everything else.
- Imports are serialized inside the server (Companion allows one upload session at a time); parallel calls wait for each other.
- Appending (`target_page: -1`) has no snapshot. Undo it by deleting the page in Companion.

### `companion_rollback`

Takes the `snapshot` object exactly as returned by `companion_import_page`. The checksum is verified first (a modified snapshot is `SNAPSHOT_INVALID`); a snapshot taken on another host is refused (`SNAPSHOT_HOST_MISMATCH`). The applied rollback exports the current page first (`pre_rollback_snapshot`, so the rollback can be undone), re-imports the snapshot into the same page number, reusing connections that still exist, and reads back.

## Configuration

| Variable                              | Default                   | Meaning                                                                                   |
| ------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `COMPANION_URL`                       | `http://127.0.0.1:8000`   | Base URL of Companion. Credentials and path are dropped.                                  |
| `COMPANION_REST_TOKEN`                | unset                     | REST v2 token (`cpn_...`); only for `list_connections` and `list_surfaces`. Never output. |
| `COMPANION_MCP_ALLOW_UNKNOWN_VERSION` | `0`                       | `1`/`true` accepts Companion versions other than 5.1.x (the tRPC API is internal).        |
| `COMPANION_MCP_WRITE`                 | `0`                       | `1`/`true` enables `import_page` and `rollback` with `dry_run: false`.                    |
| `COMPANION_MCP_ALLOWED_HOSTS`         | `127.0.0.1,localhost,::1` | Comma separated hosts the server may contact. Ports are ignored.                          |
| `COMPANION_MCP_PRESS_ALLOW`           | unset                     | `page/row/column` list for button presses (reserved for the Satellite tools).             |

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

## Tests

`npm test` runs the tools against an in-memory MCP client and a fake Companion built on the shared mock WebSocket server. With `COMPANION_TEST_URL` set (a **throw-away** Companion 5.1.x), `test/tools/integration.test.ts` additionally runs `generate_page(atem)`, `import_page`, `get_page` and `rollback` against the real instance; it replaces page 1 and restores it, and the ATEM page adds a connection.
