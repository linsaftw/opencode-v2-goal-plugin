# OpenCode V2 Goal Autopilot

**Persistent, objective-driven autonomous execution for OpenCode 2.** Define a goal with `/goal`; the plugin keeps queuing agent turns until the goal is marked complete, genuinely blocked, or explicitly interrupted. No artificial wall-clock limit, turn limit, or inactivity cutoff.

[![CI](https://github.com/linsaftw/opencode-v2-goal-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/linsaftw/opencode-v2-goal-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> [!IMPORTANT]
> **OpenCode V2 only.** This is a beta-API integration. The code and a simulated V2 lifecycle are tested, but compatibility with every OpenCode 2 build and provider has **not** been established through a live host integration test.

## Why this exists

A command template by itself runs once. A true goal runner must react when execution ends, submit the next prompt, retain its objective across context compaction, and stop only for a defined reason. This project combines a normal discoverable `commands/goal.md` slash command with a local OpenCode V2 server plugin that implements the execution loop.

```text
/goal <objective>
      │
      ▼
Save complete objective (private snapshot) ──► Start agent
                                                    │
                                                    ▼
                                         Execution succeeded?
                                          │               │
                                          │ yes           │ failed/interrupted
                                          ▼               ▼
                                    Goal complete?      Pause
                                     │       │
                                     │ no    │ yes
                                     ▼       ▼
                              Queue next turn  Stop
                                     │
                                     └──► Agent executes again
```

## Features

- **Real autonomous continuation** through the OpenCode 2 event stream and `ctx.session.prompt({ delivery: "queue" })`, not a prompt-only loop.
- **Native `/goal` discoverability** through a Markdown command file installed separately from the plugin.
- **No plugin-imposed limits** on goal length, total duration, iterations, or token spending.
- **Large objective support:** long pasted objectives and UTF-8 Markdown/text specifications using `/goal --file`.
- **Complete objective preservation:** full text is saved to disk; large goals are accessed through the session-scoped `goal_read` tool instead of being repeatedly pasted into context.
- **Explicit completion and blocker tools:** `goal_complete` requires a summary and test/evidence text; `goal_blocked` requires a concrete reason.
- **Session-scoped persistence, pause, resume, clear, and status.**
- **No runtime npm dependencies**, no installer downloads, no remote telemetry from the plugin itself.

## Requirements

- OpenCode **2.x** with the [V2 server plugin API](https://opencode.ai/v2/docs/build/plugins/).
- Node.js **22+** only for repository development/testing. OpenCode must itself support Node built-in imports at plugin runtime.
- Bash and standard Unix tools for the provided installer (Linux, macOS, or WSL).
- A configured OpenCode provider and permissions for the requested work.

## Install

Clone the repository:

```bash
 git clone https://github.com/linsaftw/opencode-v2-goal-plugin.git
 cd opencode-v2-goal-plugin
 bash install.sh
```

Or download GitHub's **Code → Download ZIP**, extract it, and run `bash install.sh` from the extracted directory.

The installer detects `opencode2` first, then `opencode`, and accepts only a reported **2.x.y** version. It copies these files:

```text
~/.config/opencode/
  commands/goal.md
  plugins/goal-autopilot-v3/
    index.js
    package.json
```

For a verified OpenCode V2 installation whose binary is not on the installer's PATH, use `OPENCODE_VERSION=2.x.y bash install.sh`, replacing `2.x.y` with the actual version. This bypasses executable detection; it does not alter the host's compatibility.

Existing files at the same paths are backed up under `~/.config/opencode/goal-autopilot-backups/`. The install also backs up/renames our older `plugins/goal-autopilot.js` V2 artifact to avoid two runners. Disable any *other* autonomous-goal plugins manually before running this one.

**Restart the OpenCode 2 server/TUI after installation.** From the OpenCode terminal:

```bash
opencode2 api get /api/plugin
opencode2 api get /api/command
```

Confirm `local.goal-autopilot-v3` and the command `goal` are present. See [OpenCode V2 troubleshooting](https://opencode.ai/v2/docs/troubleshooting/) if discovery fails. An `opencode2` binary is typical for V2 installations; use your version's equivalent executable if it differs.

## Usage

### Normal and multiline goals

```text
/goal Implement the requested feature, run the appropriate tests, and fix regressions before completion.
```

Long pasted specifications are accepted. The earlier **16,000-character limit is removed**; no silent truncation occurs in the plugin.

### Goal from a large file (recommended)

Create a UTF-8 text/Markdown file in your project. Then:

```text
/goal --file /absolute/path/to/requirements.md
```

For project-local files, relative paths are resolved against the plugin's OpenCode location directory:

```text
/goal --file ./docs/requirements.md
/goal --file "./docs/long requirements.md"
```

**Prefer an absolute path** when OpenCode's server manages multiple project directories; a plugin's location may differ from the currently viewed session's working directory. Shell expansion is not performed, but the `~/` prefix is supported.

The contents are read once and saved as a new private snapshot. Later edits to the source file **do not silently change the active objective**; restart `/goal --file ...` to replace the goal.

For long inputs the agent is instructed to call `goal_read({ offset: 0 })`, and then follow `nextOffset` to read every page, before implementing or declaring completion. `goal_read` serves only the objective owned by the current session. The default page is 12,000 characters, adjustable up to 20,000 per call. **There is no limit on total objective size imposed by the plugin.** Unlike the built-in `read` tool, `goal_read` does not require additional `external_directory` permissions to access a private goal snapshot. The model still has finite context and must process exceptionally large objectives in chunks.

### Control commands

| Command | Action |
| --- | --- |
| `/goal` or `/goal status` | Display objective summary, state, execution count, and snapshot path |
| `/goal pause` | Pause the autonomous loop |
| `/goal resume` | Resume a paused or blocked objective |
| `/goal clear` | Delete the saved goal and its private objective snapshot |
| `/goal help` | List available commands |

Entering a normal user message while a goal is active pauses the runner. An OpenCode execution failure or interruption also pauses it rather than automatically retrying a potentially broken operation. To continue deliberately, run `/goal resume`.

The model can call:

- `goal_complete({ summary, evidence })` — mark the objective complete only after checking all requirements against real implementation/test evidence.
- `goal_blocked({ reason })` — report a genuinely external blocker that prevents more authorized progress.
- `goal_read({ offset?, limit? })` — retrieve all requirements from a large goal, in numbered pages.

**Evidence is model-reported**, not independently verified by an external auditor. Test success alone does not prove every requirement is complete. If a model incorrectly calls `goal_complete`, the plugin cannot independently catch that.

## How the loop works

1. The `/goal` Markdown template places a structured control message into OpenCode's prompt.
2. The prompt hook interprets it, saves state and an objective snapshot, and supplies goal instructions. Surrounding whitespace in directly pasted goals is normalized; file-sourced goals retain the exact file contents.
3. The goal stays `active` while the model works. The context and compaction hooks restore the standing objective instructions.
4. On a `session.execution.succeeded` event, the plugin records an execution and sends another queued prompt using the session API, unless `goal_complete` or `goal_blocked` has changed the state.
5. On `session.execution.failed` / `.interrupted`, it pauses. On normal user input or `/goal pause`, it also pauses.
6. Each session has its own state. Reloaded state can be resumed using `/goal resume` if the OpenCode service restarts mid-goal.

Goal state is stored in `~/.local/state/opencode-goal-autopilot-v3/` by default, or the directory specified by `OPENCODE_GOAL_STATE_DIR`. JSON state files and verbatim `.md` objective snapshots use owner-only permissions when created (Unix `0600`). These files contain **plaintext goal text**; do not put secrets in objectives.

## What *unlimited* means

No arbitrary turn/time/goal-size cap exists **in this plugin**. Provider quotas, API costs, the host's context window, permissions, execution failures, account limits, user cancellation, and actual system resources **still apply**. It does not bypass OpenCode permissions, automatically recover from every provider failure, or promise successful completion.

## Development

No `npm install` is required for source development.

```bash
npm run ci
bash -n install.sh uninstall.sh
```

Tests run on Node 22 and 24 in GitHub Actions and cover goal-state persistence, repeated autonomous continuations, completion/blocking, interruption, large objectives, paged `goal_read` recovery, file-backed goals, installer behavior, and other regressions. The host API is simulated by test doubles; a passing unit suite is **not** a live OpenCode integration test.

## Uninstall

```bash
bash uninstall.sh
```

Removes this version's command and plugin only when the expected identifiers are detected. Backups and saved goals are intentionally retained; the script does not touch unrelated OpenCode configuration.

## Contributing, security, and license

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md). Licensed under [MIT](LICENSE).

OpenCode V2 documentation: [commands](https://opencode.ai/v2/docs/commands/), [plugins](https://opencode.ai/v2/docs/build/plugins/), [plugin discovery](https://opencode.ai/v2/docs/plugins).
