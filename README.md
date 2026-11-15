# companion-mcp

[![CI](https://github.com/rA1nm3n/companion-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rA1nm3n/companion-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for [Bitfocus Companion](https://bitfocus.io/companion), focused on **creating and maintaining Companion configuration** with an AI assistant: pages, buttons, actions, feedbacks and verified read-back.

> **Status: early development (pre-0.1).** Not published to npm yet; the tool surface may still change. Tested against Companion **5.1.3** only.

> This project is not affiliated with or endorsed by Bitfocus.

## Why

Companion is typically configured by clicking through the UI one button at a time. For larger shows (ATEM, Videohub, vMix, PTZ cameras, media servers, dozens of pages) that is slow and error-prone. This server lets an AI assistant build, review and change that configuration through validated tools, with safeguards so a live system is not changed by accident.

## How it works

```
MCP tools ── format (offline)    export format 12: schemas, builders, validator, page templates
          ── catalog (offline)   module, action and feedback data, option validation
          ── safety              write gate, allow-lists, dry run, snapshots
          ── transport (live)    tRPC WebSocket (import/export/read-back), REST v2
          ── satellite (live)    virtual surface: see buttons as an operator does, verified key press
```

Companion has no public API for creating pages or buttons. Config is therefore **generated as an export file (format 12), validated offline, imported over Companion's internal tRPC endpoint and verified by read-back**. Details and measured pitfalls: [docs/architecture.md](docs/architecture.md).

## Tools

All tools are prefixed `companion_`. Full reference: [docs/tools.md](docs/tools.md).

| Area         | Tools                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| Catalog      | `catalog_search`, `catalog_module`, `catalog_action`                       |
| Offline      | `validate_config`, `generate_page`, `build_page`                           |
| Read         | `status`, `export`, `get_page`, `list_connections`, `list_surfaces`        |
| Write (gate) | `import_page`, `rollback` (dry run by default)                             |
| Satellite    | `satellite_snapshot`, `press` (see [docs/satellite.md](docs/satellite.md)) |

Page templates exist for ATEM, Videohub, vMix and BirdDog. The catalog covers 15 modules in detail (ATEM, Videohub, vMix, BirdDog, HyperDeck, Panasonic PTZ, Analog Way AWJ/LivePremier, Barco EventMaster, Shure, Luminex GigaCore, Dataton Watchout, Resolume, Companion internal) and indexes 104 modules. See [docs/catalog.md](docs/catalog.md).

## Safety model

This server can change a system that may be running a live production.

1. Writes are **disabled by default**. Enable with `COMPANION_MCP_WRITE=1`.
2. Only **allow-listed hosts** can be targeted (`COMPANION_MCP_ALLOWED_HOSTS`, default `127.0.0.1,localhost,::1`).
3. Every write tool has `dry_run` (default `true`) and returns the plan without side effects.
4. Applied imports take a **checksummed snapshot** first and are **verified by read-back**; silently dropped controls are reported as errors.
5. Button presses are restricted by an allow-list (`COMPANION_MCP_PRESS_ALLOW`), need the write gate and report success only from an observed render change, never from the satellite `OK` alone.

Note: Companion's tRPC endpoint and the Satellite ports have **no authentication** (the Satellite ports listen on all interfaces). Run Companion on a trusted network. See [SECURITY.md](SECURITY.md).

## Requirements

- Node.js 22.12 or newer
- A running Bitfocus Companion **5.1.x** instance reachable from the machine running this server

## Installation

Not yet published. Use it from source:

```sh
git clone https://github.com/rA1nm3n/companion-mcp.git
cd companion-mcp
npm ci
npm run build
```

Example MCP client configuration (Claude Desktop / Claude Code):

```json
{
  "mcpServers": {
    "companion": {
      "command": "node",
      "args": ["/path/to/companion-mcp/dist/cli.js"],
      "env": {
        "COMPANION_URL": "http://127.0.0.1:8000"
      }
    }
  }
}
```

Configuration variables and typical workflows (generate, validate, dry run, import, read-back, rollback) are described in [docs/tools.md](docs/tools.md).

## Development

```sh
npm ci                # install dependencies
npm run typecheck     # TypeScript, no emit
npm test              # unit tests (Vitest); integration tests are skipped without COMPANION_TEST_URL
npm run format        # check formatting (Prettier)
npm run build         # compile to dist/
```

Integration tests need a Companion 5.1.x instance: set `COMPANION_TEST_URL` (and `COMPANION_TEST_SATELLITE_PORT` for satellite tests) and run `npm run test:integration`. Never point them at a production system.

See [CONTRIBUTING.md](CONTRIBUTING.md) for workflow, commit style and review expectations.

## Roadmap

| Milestone | Scope                                                                                    | Status      |
| --------- | ---------------------------------------------------------------------------------------- | ----------- |
| 0.1       | Format 12 generator and validator, catalog, safety, transport, satellite, MCP tools      | in progress |
| 0.2       | Triggers (`importTriggers`), full-config import, rollback of appended pages, page select | planned     |
| 0.3       | More templates (HyperDeck, PTZ, media servers), fuller catalog coverage                  | planned     |
| later     | Support for newer Companion releases once format and tRPC changes are measured           | open        |

## Related projects

- [yannisgu/companion-mcp-server](https://github.com/yannisgu/companion-mcp-server) (MIT)
- [drohi-r/companion-mcp](https://github.com/drohi-r/companion-mcp) (Apache-2.0)

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
