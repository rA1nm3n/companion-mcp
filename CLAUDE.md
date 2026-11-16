# companion-mcp: instructions for Claude

Public repo `rA1nm3n/companion-mcp`: MCP server for Bitfocus Companion 5.x, focus on config creation. See README.md for goals and safety model.

## Conventions

- Chat with the maintainer in **German**. Everything in the repo (code, comments, docs, issues, PRs, commits) in **English**.
- Never work on `main` directly: branch (`feat/`, `fix/`, `docs/`, `chore/`), open a PR.
- Conventional Commits. Update `CHANGELOG.md` (Unreleased) for user-visible changes.
- Do not guess Companion behavior: verify against a running instance or the official source/docs and state the tested version.
- Safety first: write tools go through the write gate and support dry run. Never weaken defaults silently.
- No real customer data, IPs or credentials in fixtures, tests or docs.

## Commands

```sh
npm ci
npm run typecheck
npm test
npm run format        # check; use `npm run format:write` to fix
npm run build
```

## Research

Background research notes (API, config model, prior art) are kept outside the repo until reviewed. When they are verified, summarize the relevant parts in `docs/`.
