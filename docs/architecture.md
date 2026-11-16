# Architecture

Target: Bitfocus Companion **5.1.x** (verified against 5.1.3 built from source). Focus: **creating and maintaining configuration**.

## Layers

```
MCP tools (src/tools)            thin wrappers: validate input, call modules, shape output
  |
  +-- format  (src/format)       OFFLINE. Zod schemas, builders, validator, page templates for the
  |                              .companionconfig export format. No network, no I/O.
  +-- catalog (src/catalog)      OFFLINE. Data about Companion modules: module id, actions, feedbacks,
  |                              option schemas. Used by format builders and by validation.
  +-- safety  (src/safety)       Write gate, host allow-list, dry run, snapshot/rollback plan.
  +-- transport (src/transport)  LIVE. tRPC-over-WebSocket client (/trpc) and REST v2 client (/api/v2).
  +-- satellite (src/satellite)  LIVE. Satellite API client: virtual surface for render readback and key press.
```

Dependency rule: `format` and `catalog` import nothing from `transport`, `safety`, `satellite`, `tools`. `tools` may import everything. `transport` and `satellite` may import `safety` types only.

## Measured facts that drive the design

(Measured on Companion 5.1.3, see research notes; do not weaken without re-measuring.)

1. Export/import file `"version"` is **12** for releases 5.0.0 to 5.1.3 (`main` writes 17). Import performs **no version check**.
2. A legacy control of type `button` inside a file with version 17 is **silently dropped** while the import reports success. Always write version 12 with `button-layered` controls and **always verify by read-back** after an import.
3. Import over tRPC (WebSocket, no transformer): `importExport.prepareImport.start`, `uploadChunk`, `complete` and the import procedure must run on the **same connection**.
4. `lastUpgradeIndex`: missing becomes `-1`; entities inherit the instance value. Double migration at module start with `-1` is unmeasured.
5. Connections without `updatePolicy` make REST v2 `GET /connections/v1` fail with 500. Always set `updatePolicy` (`'manual'` default).
6. REST v2 (`/api/v2`, Bearer token, off by default) covers only connections and surfaces. Pages, buttons and triggers are only reachable via tRPC or file import.
7. tRPC is internal and undocumented: check the Companion version at connect and refuse unknown major/minor versions unless explicitly allowed.
8. The tRPC endpoint has **no authentication**. Safety relies on the host allow-list and the write gate.

## Safety model (all write paths)

- `COMPANION_MCP_WRITE=1` is required for any write. Default: disabled.
- `COMPANION_MCP_ALLOWED_HOSTS` (comma separated). Default: `127.0.0.1,localhost,::1`.
- Every write tool takes `dry_run` (default `true`) and returns the planned change without side effects.
- Before an applied import: take a snapshot (export of the affected scope) and return it with the result so the change can be rolled back.
- After an applied import: read back and diff against the intended content; report mismatches as errors.
- Optional `COMPANION_MCP_PRESS_ALLOW` (list of `page/row/column`) restricts button presses.
- Never log tokens. No real customer data or IPs in fixtures or docs.

## Module contracts

### `src/format`

- `FILE_VERSION = 12`.
- Zod schemas for: page export, trigger export, full export subset; button (`button-layered`), steps / action sets, actions, feedbacks (with style overrides), local variables, connections.
- Builders: `buildButton`, `buildPageExport`, `buildTriggerExport`, ID generation (stable, injectable for tests).
- `validateExport(json): { ok: boolean; errors: Issue[]; warnings: Issue[] }`. Errors include: wrong version, legacy `button` type, missing `updatePolicy`, unknown module/action/option (via catalog), option value type mismatches, coordinates outside the page grid.
- Page templates (pure functions returning export objects), e.g. ATEM program/preview/cut/auto page, Videohub routing page, vMix input page.

### `src/catalog`

- JSON data per module in `src/catalog/data/<moduleId>.json`, typed loader and validators.
- `listModules()`, `getModule(id)`, `findAction(moduleId, actionId)`, `findFeedback(...)`, `validateActionOptions(moduleId, actionId, options): Issue[]`.
- Every entry carries provenance: repo, module version, base version, source file and line, verification status (`read` | `measured`).

### `src/safety`

- `loadSafetyConfig(env)`, `assertWriteAllowed(config, host)`, `planWrite(...)` (dry-run result), snapshot and rollback helpers (rollback = re-import of the snapshot).

### `src/transport`

- `CompanionTrpc`: connect, `getVersion()`, `exportFull()`, `exportPage(page)`, `importPage(...)`, `getPage(page)`, `close()`. Import steps share one connection.
- `RestV2Client`: token auth, `listConnections()`, `listSurfaces()`, `getOpenApi()`.
- Version guard and typed errors.

### `src/satellite`

- Satellite API client (virtual surface). Spec follows the measured protocol notes once available.

### `src/tools`

- MCP tool registration (stdio server). Each tool: strict Zod input schema, explicit description of side effects, structured JSON output with `ok` and `errors`.

## Testing

- Unit tests (Vitest) for every module; fixtures are anonymized.
- Integration tests against a real Companion run only when `COMPANION_TEST_URL` is set and are skipped otherwise (CI stays hermetic).
- Format validator tests must include the measured pitfalls (legacy `button` type, wrong version, missing `updatePolicy`).

## Conventions

- TypeScript strict, ESM, `.js` extensions in relative imports, no `any`.
- English for code, comments and docs.
