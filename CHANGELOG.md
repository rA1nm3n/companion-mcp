# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-11-16

### Added

- Catalog: full action and feedback data for all remaining usable modules of the index (124 modules in total), read from the module sources with file and line: QLab, ProPresenter, Keynote, PowerPoint, OBS Studio, Ableton OSC, Disguise, Pixera, Hippotizer REST, Millumin, ArKaos, ModuloPlayer, SModeLive, DT Videolabs, Pandoras Box, CasparCG, Resolume WS and Arena OSC, Sony, PTZOptics and HDKatov VISCA, Panasonic cameras, Kairos and projector, NEC, Ross, Tally Arbiter, TSL, Vizrt, Extron, Kramer, Lightware, Crestron, Novastar, PixelHue, Brompton, Analog Way, Barco, BMD Multiview 4, Christie, Teradek, Epiphan Pearl and the generic Art-Net, sACN, HTTP, OSC, MIDI, PJLink and TCP/UDP modules.

### Changed

- Datavideo VISCA and Green Hippo Hippotizer are legacy modules without a manifest id and moved from the index to `unusable`.

## [1.0.0] - 2026-11-16

First stable release. Everything listed below is part of 1.0.0.

### Added

- Repository standards: README, MIT license, contributing guide, security policy, issue and pull request templates, CI, Dependabot configuration.
- TypeScript project skeleton with Vitest and Prettier.
- Format layer (`src/format`): Zod schemas for the Companion 5.1.x export format 12 (`button-layered`), builders, a validator covering measured import pitfalls (wrong version, legacy `button` controls that are silently dropped, missing `updatePolicy`), and page templates for ATEM, Videohub, vMix and BirdDog.
- Module catalog (`src/catalog`): typed action and feedback data for 38 modules and an index of 126 modules, with option validation and provenance.
- Catalog: lighting console modules with full action and feedback data (MA Lighting grandMA2 and grandMA3, ChamSys MagicQ OSC and UDP).
- Catalog data for five lighting console modules: Avolites Titan (55 actions, 4 feedbacks), ETC Eos (15, 5), High End Hog 4 (10, 0), Obsidian ONYX telnet (11, 1) and ONYX OSC (5, 2), all read from source with file and line. Chauvet Infinity Chimp is recorded under `noModule` because no Companion module exists.
- Catalog data for media and pixel software: TouchDesigner, MADRIX Aura, GarageCube MadMapper 5 and 6 (new); Resolume Arena now complete (10 effect feedbacks added, five OSC colour defaults, corrected effect dropdown label). MADRIX software and Resolume Wire are listed as devices without a module; community Resolume modules are indexed.
- Catalog: audio consoles (Yamaha RCP/SCP, Behringer X32, Allen & Heath SQ, Avantis, dLive, dLive/iLive, CQ, AHM, DT168) with data from the module sources, seven Allen & Heath modules added to the index, no-module entries for Qu, GLD, ZED and Xone, and `allowCustom` handling in the option validator.
- Safety layer (`src/safety`): write gate (off by default), host and press allow-lists, dry-run plans, checksummed snapshots and rollback plans.
- Transport layer (`src/transport`): tRPC WebSocket client (import on a single connection, read-back, version guard), REST v2 client and a read-back diff.
- Satellite client (`src/satellite`): virtual surface over the Satellite API (TCP and WebSocket), settled page snapshots and `pressVerified`, which reports success only from a render change.
- MCP server (`src/server.ts`, `src/cli.ts`) with 15 `companion_*` tools: catalog lookup, validation, page generation and building, status, export, page read-back, connection and surface listing, `import_page` and `rollback` (both dry-run by default), `satellite_snapshot` (read the rendered page) and `press` (dry run by default, write gate and press allow-list, reports `accepted`, `render_changed`, `target_changed`, `page_changed`).
- `diffReadback` options `connectionIdMap` and `inferConnectionIds`: remapped entity `connectionId`s (explicit import remapping or a consistent 1:1 mapping, contradictions stay errors) and an absent versus empty `children` are tolerated inside the diff. The tool layer no longer rewrites the intended export.
- Claude Desktop extension: `npm run bundle` builds `build/companion-mcp-<version>.mcpb` (manifest 0.3, production dependencies only, tool list read from the real server, validated with the official `mcpb` CLI pinned in the script). The install dialog exposes URL, REST token (sensitive), write gate (off), allowed hosts, press allow-list and the unknown-version switch.
- `sanitizeEnv`: environment values that still contain an unreplaced `${...}` placeholder are treated as unset, so an empty optional extension field can never become a literal token or URL.
- ShowPace (Stagetimer) in the catalog: `showpace-timer`, the maintainer's own module (source `rA1nm3n/showpace`, `integrations/companion`, v0.2.1, commit 824fddf), complete list of 32 actions and 13 feedbacks, plus a `showpace` page template (display, start/pause/reset, previous/next segment, tempo) in `companion_generate_page`.
- Documentation: `docs/architecture.md`, `docs/catalog.md`, `docs/satellite.md`, `docs/tools.md`.

### Known limitations

- Satellite ports of Companion listen on all interfaces without authentication; see `docs/tools.md` and `docs/satellite.md`.
- Targets Companion 5.1.x only; tested against 5.1.3 built from source.
- `importFull`, `importTriggers`, page deletion on rollback of an append and page selection for satellite surfaces are not implemented.
- Catalog data comes from source code reading and sampling; it has not been tested against devices.
