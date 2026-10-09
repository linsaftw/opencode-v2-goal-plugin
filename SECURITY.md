# Security policy

## Reporting vulnerabilities

Please use GitHub's **Report a vulnerability** / private security advisory feature for
this repository, when available. Do not publish exploits or sensitive logs in a public issue.

## Security model

- The plugin runs with **the permissions the OpenCode agent already has**. It does not
  request, elevate, or bypass permissions.
- It makes **no direct external HTTP requests**. OpenCode and its configured model
  provider still communicate normally to fulfill a goal.
- It stores goal text and completion evidence in local, unencrypted JSON files, under
  `~/.local/state/opencode-goal-autopilot-v3/`, or `OPENCODE_GOAL_STATE_DIR`.
- It also stores private full-text `.md` snapshots in the same directory. These
  files are created with `0600` permissions on Unix, but are not encrypted.
- The autonomy loop has **no time, turn, token, or spending cap**. Unattended execution
  can incur substantial costs or perform unwanted actions when agent permissions are broad.
- Completion evidence is provided by the model, not independently verified by the plugin.
- The OpenCode 2 plugin API is beta and may change. Test against your exact host version.

Never paste API keys or private credentials into a goal. Keep host permissions restrictive.
