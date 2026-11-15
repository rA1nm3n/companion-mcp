# Security Policy

## Supported versions

The project is pre-release. Only the latest commit on `main` is supported until 0.1 is published.

## Reporting a vulnerability

Please do **not** open a public issue.

Report privately via GitHub: **Security** tab of this repository → **Report a vulnerability** (private vulnerability reporting).

Please include:

- affected version or commit,
- a description of the impact and steps to reproduce,
- the Companion version you tested against.

You can expect an initial response within 7 days. Fixes are published together with a GitHub security advisory.

## Scope notes

This server can modify the configuration of a Bitfocus Companion instance, which may control live production equipment. Relevant issues include, for example:

- bypassing the write gate, host allow-list or button allow-list,
- unintended writes during dry run or preview,
- leaking credentials or tokens,
- command or request injection towards Companion.

Vulnerabilities in Bitfocus Companion itself should be reported to Bitfocus.
