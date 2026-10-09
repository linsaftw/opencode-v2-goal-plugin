#!/usr/bin/env bash
set -euo pipefail
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
TARGET="$CONFIG/plugins/goal-autopilot-v3"
COMMAND="$CONFIG/commands/goal.md"

if [[ -d "$TARGET" ]]; then
  if [[ ! -f "$TARGET/index.js" ]] || ! grep -Fq "local.goal-autopilot-v3" "$TARGET/index.js"; then
    echo "ERROR: $TARGET does not look like this plugin; refusing to remove it." >&2
    exit 1
  fi
  rm -rf -- "$TARGET"
  echo "Removed plugin: $TARGET"
fi
if [[ -f "$COMMAND" ]] && grep -Fq '<opencode-goal-control v="3">' "$COMMAND"; then
  rm -- "$COMMAND"
  echo "Removed /goal command: $COMMAND"
fi
printf '%s\n' 'Done. Previous files in goal-autopilot-backups were not restored or deleted.' \
  'Restart OpenCode to unload any cached plugin instance.'
