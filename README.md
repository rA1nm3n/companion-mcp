# companion-mcp

[![CI](https://github.com/rA1nm3n/companion-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rA1nm3n/companion-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for [Bitfocus Companion](https://bitfocus.io/companion), focused on **creating and maintaining Companion configuration** with an AI assistant: pages, buttons, actions, feedbacks, triggers and import/export.

> **Status: early development (pre-0.1).** Nothing is published yet and the tool surface is not stable. See the [roadmap](#roadmap).

> This project is not affiliated with or endorsed by Bitfocus.

## Why

Companion is typically configured by clicking through the UI one button at a time. For larger shows (ATEM, Videohub, vMix, PTZ cameras, dozens of pages) that is slow and error-prone. This server lets an AI assistant build, review and change that configuration through well-defined, validated tools, with safeguards so a live system is not changed by accident.

## Goals

- **Config creation first:** create pages and buttons including styles, steps, actions and feedbacks; create and edit triggers; generate pages from templates.
- **Companion 5.x as the target API.** Older major versions are not a goal unless explicitly added later.
- **Safe by default:** read-only mode, dry-run previews, snapshots and rollback before batch writes, host allow-list.
- **Validated input:** every tool has a strict schema; action and feedback options are checked against the connection's definitions where available.
- **Reproducible:** configuration can be exported and kept in version control.

## Non-goals

- Replacing the Companion UI.
- Live show operation as the primary use case (pressing buttons is supported, but secondary and gated).
- Supporting Companion 3.x.

## Safety model

This server can change a system that may be running a live production. The following rules apply to all write tools (planned):

1. Writes are **disabled by default**; they must be enabled explicitly via configuration.
2. Only **allow-listed hosts** can be targeted.
3. Batch writes offer a **preview (dry run)** and create a **snapshot** that can be rolled back.
4. Tools that trigger real-world actions (button presses) can be restricted to an **allow-list of buttons**.

Details and the exact configuration keys will be documented here once implemented.

## Requirements

- Node.js 22.12 or newer
- A running Bitfocus Companion 5.x instance reachable from the machine running this server

## Installation

Not yet published. Until the first release, use it from source:

```sh
git clone https://github.com/rA1nm3n/companion-mcp.git
cd companion-mcp
npm ci
npm run build
```

## Development

```sh
npm ci              # install dependencies
npm run typecheck   # TypeScript, no emit
npm test            # unit tests (Vitest)
npm run format      # check formatting (Prettier)
npm run build       # compile to dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for workflow, commit style and review expectations.

## Roadmap

| Milestone | Scope                                                                       |
| --------- | --------------------------------------------------------------------------- |
| 0.1       | Connection to Companion 5.x, read-only discovery (pages, buttons, triggers) |
| 0.2       | Write tools for pages/buttons with safety gate, dry run and rollback        |
| 0.3       | Actions, feedbacks and steps with option validation; triggers               |
| 0.4       | Import/export, template generators (e.g. ATEM pages)                        |

The roadmap is a plan, not a promise; see [issues](https://github.com/rA1nm3n/companion-mcp/issues) for current work.

## Related projects

- [yannisgu/companion-mcp-server](https://github.com/yannisgu/companion-mcp-server) (MIT)
- [drohi-r/companion-mcp](https://github.com/drohi-r/companion-mcp) (Apache-2.0)

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
