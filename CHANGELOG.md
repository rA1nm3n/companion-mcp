# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository standards: README, MIT license, contributing guide, security policy, issue and pull request templates, CI, Dependabot configuration.
- TypeScript project skeleton with Vitest and Prettier.
- Format layer (`src/format`): Zod schemas for the Companion 5.1.x export format 12 (`button-layered`), builders, a validator covering measured import pitfalls (wrong version, legacy `button` controls that are silently dropped, missing `updatePolicy`), and page templates for ATEM, Videohub, vMix and BirdDog.
- Module catalog (`src/catalog`): typed action and feedback data for 19 modules and an index of 108 modules, with option validation and provenance.
- Catalog: lighting console modules with full action and feedback data (MA Lighting grandMA2 and grandMA3, ChamSys MagicQ OSC and UDP).
- Safety layer (`src/safety`): write gate (off by default), host and press allow-lists, dry-run plans, checksummed snapshots and rollback plans.
- Transport layer (`src/transport`): tRPC WebSocket client (import on a single connection, read-back, version guard), REST v2 client and a read-back diff.
- Satellite client (`src/satellite`): virtual surface over the Satellite API (TCP and WebSocket), settled page snapshots and `pressVerified`, which reports success only from a render change.
- MCP server (`src/server.ts`, `src/cli.ts`) with 15 `companion_*` tools: catalog lookup, validation, page generation and building, status, export, page read-back, connection and surface listing, `import_page` and `rollback` (both dry-run by default), `satellite_snapshot` (read the rendered page) and `press` (dry run by default, write gate and press allow-list, reports `accepted`, `render_changed`, `target_changed`, `page_changed`).
- `diffReadback` options `connectionIdMap` and `inferConnectionIds`: remapped entity `connectionId`s (explicit import remapping or a consistent 1:1 mapping, contradictions stay errors) and an absent versus empty `children` are tolerated inside the diff. The tool layer no longer rewrites the intended export.
- Documentation: `docs/architecture.md`, `docs/catalog.md`, `docs/satellite.md`, `docs/tools.md`.

### Known limitations

- Satellite ports of Companion listen on all interfaces without authentication; see `docs/tools.md` and `docs/satellite.md`.
- Targets Companion 5.1.x only; tested against 5.1.3 built from source.
- `importFull`, `importTriggers`, page deletion on rollback of an append and page selection for satellite surfaces are not implemented.
- Catalog data comes from source code reading and sampling; it has not been tested against devices.
