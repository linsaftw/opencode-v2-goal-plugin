#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
TARGET="$CONFIG/plugins/goal-autopilot-v3"
COMMAND="$CONFIG/commands/goal.md"
BACKUP="$CONFIG/goal-autopilot-backups"

if [[ -z "${OPENCODE_VERSION:-}" ]]; then
  HOST=""
  if command -v opencode2 >/dev/null 2>&1; then HOST=opencode2
  elif command -v opencode >/dev/null 2>&1; then HOST=opencode
  else
    echo "ERROR: OpenCode executable not found. Set OPENCODE_VERSION=2.x.y to install manually." >&2
    exit 1
  fi
  RAW="$($HOST --version)"
  VERSION="$(printf '%s\n' "$RAW" | grep -oE '2\.[0-9]+\.[0-9]+([-+.][A-Za-z0-9.-]+)?' | head -1 || true)"
else
  VERSION="$OPENCODE_VERSION"
fi
if [[ ! "$VERSION" =~ ^2\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$ ]]; then
  echo "ERROR: Cannot identify an exact OpenCode V2 release (${VERSION:-unknown})." >&2
  echo "Use OPENCODE_VERSION=2.x.y bash install.sh with your actual V2 version." >&2
  exit 1
fi
mkdir -p -- "$CONFIG/plugins" "$CONFIG/commands" "$BACKUP"
STAGE="$(mktemp -d "$CONFIG/.goal-autopilot-stage.XXXXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT
cp -a -- "$ROOT/plugin/." "$STAGE/"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
if [[ -d "$TARGET" ]]; then mv -- "$TARGET" "$BACKUP/goal-autopilot-v3-$STAMP"; fi
# Old generated version conflicts with the V3 runner. Disable it without deleting its source.
LEGACY="$CONFIG/plugins/goal-autopilot.js"
if [[ -f "$LEGACY" ]]; then mv -- "$LEGACY" "$BACKUP/goal-autopilot-v2-$STAMP.js.disabled"; fi
mv -- "$STAGE" "$TARGET"
trap - EXIT
if [[ -f "$COMMAND" ]] && ! cmp -s "$ROOT/commands/goal.md" "$COMMAND"; then
  cp -- "$COMMAND" "$BACKUP/goal-$STAMP.md"
fi
install -m 0644 -- "$ROOT/commands/goal.md" "$COMMAND"
echo "Installed V3 plugin: $TARGET"
echo "Installed /goal command: $COMMAND"
echo "Backups (if existing): $BACKUP"
echo 'Restart the OpenCode V2 TUI/server, then verify:'
echo '  opencode2 api get /api/plugin'
echo '  opencode2 api get /api/command'
echo 'No npm or network access was required.'
echo 'Disable all other installed goal loop plugins before using /goal.'
