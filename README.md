# companion-mcp

[![CI](https://github.com/rA1nm3n/companion-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rA1nm3n/companion-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for [Bitfocus Companion](https://bitfocus.io/companion) that lets an AI assistant **build, check, import and verify Companion configuration**: pages, buttons, actions, feedbacks and a verified read-back, with a write gate and dry run so a live show is never changed by accident.

> **Status: 1.0.** Tested against Companion **5.1.3** only (5.1.x supported, other versions are refused unless you opt in). Catalog data is read from the module sources and sampled; it has **not** been tested against real devices.

> This project is not affiliated with or endorsed by Bitfocus.

## Highlights

- **Config creation, not just remote control.** Describe a show ("ATEM with 8 inputs, Videohub 20x20, vMix tally") and get a ready-to-import page.
- **Knows the modules.** Typed action and feedback data for **38 modules** with every option (type, range, choices, defaults), each entry with file and line of the module source it was read from, plus a searchable index of **126 modules**.
- **Validates before it touches anything.** Format 12 schemas and a validator that catches the measured import pitfalls, such as wrong export version, legacy `button` controls that Companion silently drops, or missing `updatePolicy`, and checks action options against the catalog.
- **Safe by default.** Writes off, host allow-list, dry run, checksummed snapshot, read-back diff, rollback.
- **Sees what the operator sees.** A virtual Satellite surface reads the rendered buttons (text, colour, bitmap). A button press is reported as successful only when the render actually changed.
- **15 `companion_*` tools**, 775 automated tests, strict TypeScript, CI on Node 22 and 24.
- **Claude Desktop extension.** One `.mcpb` file with an install dialog for URL, token and safety options.

## What you can ask for

- "Build a page for an ATEM Constellation with 16 inputs, program and preview colours, plus cut and auto."
- "Generate a Videohub 20x20 routing page and validate it against the catalog."
- "Create a ShowPace page: start, pause, reset, previous and next segment, tempo 110, 120 and 135 percent."
- "Which actions does the grandMA3 module have for executors? Show me the options."
- "Read page 3 back and compare it with what we planned."
- "Do a dry run of the import and show me exactly what would change."
- "Roll page 3 back to the snapshot from before the import."
- "Take a snapshot of what the Stream Deck currently shows."

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

### Page templates

`companion_generate_page` builds a validated page from a template: **ATEM**, **Videohub**, **vMix**, **BirdDog** and **ShowPace** (the maintainer's own stage timer). `companion_build_page` builds any page from a free specification of buttons, actions and feedbacks.

### Module catalog

38 modules with full action and feedback data, 126 in the searchable index (`companion_catalog_search` finds the module id, repository and version for every one of them). See [docs/catalog.md](docs/catalog.md).

| Area                        | Full data                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switchers, routing, vision  | Blackmagic ATEM, Videohub, HyperDeck, vMix, BirdDog PTZ, Panasonic PTZ                                                                                               |
| Presentation and media      | Analog Way AWJ and LivePremier, Barco EventMaster, Dataton Watchout, Resolume Arena, TouchDesigner, MADRIX Aura, MadMapper 5/6                                       |
| Lighting consoles           | MA Lighting grandMA2 and grandMA3, ChamSys MagicQ (OSC, UDP), Avolites Titan, ETC Eos, High End Hog 4, Obsidian ONYX (telnet, OSC)                                   |
| Audio                       | Yamaha RCP, Behringer X32, Allen & Heath SQ, Avantis, dLive, dLive/iLive, CQ, AHM, DT168, Shure wireless                                                             |
| Network and show control    | Luminex GigaCore, ShowPace, Companion internal actions                                                                                                               |
| Index only (search, no I/O) | QLab, ProPresenter, OBS Studio, Disguise, Pixera, Hippotizer, Sony and PTZOptics cameras, TSL, Ross, Extron, Kramer, Crestron, Brompton, Novastar, Christie and more |

Gear without a Companion module (for example Chauvet Infinity Chimp, MADRIX software, Resolume Wire) is recorded as such, so the assistant says so instead of inventing an action.

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

Not yet published to npm. Two ways to use it:

### Claude Desktop extension (`.mcpb`)

Build the bundle (needs Node.js 22.12+ and network access for `npx`) and open the file:

```sh
git clone https://github.com/rA1nm3n/companion-mcp.git
cd companion-mcp
npm ci
npm run bundle        # writes build/companion-mcp-<version>.mcpb
```

Double-click the `.mcpb` file, or drag it into Claude Desktop under Settings → Extensions. The install dialog asks for the Companion URL (default `http://127.0.0.1:8000`) and the safety options. **Writing to Companion is off by default**; the host allow-list defaults to loopback. Placeholders the host leaves unreplaced are treated as unset.

### From source

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
npm run bundle        # build + pack the Claude Desktop extension (build/*.mcpb)
```

Integration tests need a Companion 5.1.x instance: set `COMPANION_TEST_URL` (and `COMPANION_TEST_SATELLITE_PORT` for satellite tests) and run `npm run test:integration`. Never point them at a production system.

See [CONTRIBUTING.md](CONTRIBUTING.md) for workflow, commit style and review expectations.

## Limitations

- Targets Companion **5.1.x** only.
- Catalog data comes from source reading and sampling, not from devices. Treat unusual option values with care and check with `companion_satellite_snapshot` after a write.
- Not implemented yet: triggers (`importTriggers`), full-config import, page deletion on rollback of an appended page, page selection for satellite surfaces.
- Companion's tRPC endpoint and Satellite ports have no authentication; keep Companion on a trusted network.

## Roadmap

| Milestone | Scope                                                                                                                          | Status   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1.0       | Format 12 generator and validator, catalog, safety, transport, satellite, MCP tools, Claude Desktop extension                  | released |
| 1.1       | Triggers (`importTriggers`), full-config import, rollback of appended pages, page selection                                    | planned  |
| 1.2       | More templates (lighting, audio, HyperDeck, PTZ), more modules with full data (QLab, ProPresenter, OBS, Disguise, Pixera, TSL) | planned  |
| later     | Newer Companion releases once format and tRPC changes are measured                                                             | open     |

## Related projects

- [yannisgu/companion-mcp-server](https://github.com/yannisgu/companion-mcp-server) (MIT)
- [drohi-r/companion-mcp](https://github.com/drohi-r/companion-mcp) (Apache-2.0)

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
