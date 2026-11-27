# Security

somememos holds a person's private notes and the record of how they use them, so security problems matter to us even though this is a small project.

## Reporting a problem

Please report a suspected vulnerability privately, not in a public issue or pull request:

<!-- OWNER: replace this line with the contact to use, for example a security email address or GitHub's "Report a vulnerability" (private vulnerability reporting, enabled in the repository's Settings → Security). -->

**Contact: _to be filled in by the maintainer_.**

Include what you found, how to reproduce it (with invented data only, never anyone's real notes), and what you think its impact is. We aim to reply within a week. Please give us a reasonable time to release a fix before you disclose the problem publicly.

## Scope

In scope: the server and its API (`packages/server`, `apps/web` under `/api`), the public blog pages (`/blog`), the web app and its offline storage, the CLI, and the deployment files in this repository (`Dockerfile`, `railway.json`, `docs/deploy.md`).

The server is designed as a single-user server with bearer tokens (see `docs/deploy.md`). Reports about running it without a token, without TLS, or with a weak token you chose yourself are welcome as documentation improvements, but are not vulnerabilities in themselves.

## Supported versions

Only the latest release receives security fixes.

The most recent security review is in [docs/security-review-2026-11-27.md](docs/security-review-2026-11-27.md).
