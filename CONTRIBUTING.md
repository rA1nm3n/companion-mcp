# Contributing

Thanks for helping. This project controls live production equipment configuration, so correctness and safety matter more than speed.

## Ground rules

- Language of code, comments, issues, PRs and docs: **English**.
- Open an issue before large changes so the approach can be agreed first.
- One logical change per pull request. Keep PRs small and reviewable.
- Do not weaken safety defaults (write gate, allow-lists, dry run, rollback) without an explicit discussion in an issue.

## Setup

Requirements: Node.js 22.12+ and npm.

```sh
git clone https://github.com/rA1nm3n/companion-mcp.git
cd companion-mcp
npm ci
```

## Workflow

1. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
2. Make the change **with tests**. Bug fixes start with a failing test.
3. Run all checks locally:
   ```sh
   npm run typecheck
   npm test
   npm run format
   npm run build
   ```
4. Update `CHANGELOG.md` (section `Unreleased`) for user-visible changes.
5. Open a pull request against `main` and fill in the template. CI must be green.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes.

## Code standards

- TypeScript in strict mode; avoid `any`. Validate external input (including Companion responses) at the boundary.
- Every MCP tool has a strict input schema and a clear description of side effects.
- Write tools must go through the safety gate and support a dry run.
- Never log secrets or tokens.
- Do not commit real show files, IP addresses of customer networks or credentials. Use anonymized fixtures.

## Compatibility

The target is Bitfocus Companion 5.x. Changes that depend on Companion internals must state the tested Companion version in the PR description.

## Reporting security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
