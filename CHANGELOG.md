# Changelog

## 3.1.0 — 2026-10-09

- Remove the 16,000-character objective limit; long pasted objectives are never truncated.
- Add `/goal --file <path>` for durable snapshots of large UTF-8 specifications.
- Preserve the complete objective in private on-disk snapshots and use compact
  references in model prompts for long goals to avoid repeated context inflation.
- Add `goal_read` so models can retrieve every portion of a long objective without
  needing permission to read OpenCode's private state directory.
- Add oversized-input, snapshot, file error, installer and cleanup regression tests.
- Complete first public GitHub repository documentation and community metadata.

## 3.0.0 — 2026-10-09

- Publishable repository for the OpenCode 2 autonomous goal runner.
- Native Markdown `/goal` command and V2 server plugin.
- Session-scoped goal persistence, continuation on successful execution, compaction
  reinjection, and model-facing completion/blocker tools.
- Explicit pause/resume/status/clear and user-interruption handling.
- Unlimited model turns and run duration (host/provider limits still apply).
- Dependency-free installer, automated tests, and GitHub Actions CI.

No live integration compatibility guarantee is implied by this release.
