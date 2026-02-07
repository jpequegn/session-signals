#!/usr/bin/env bash
set -euo pipefail

# ── Session Signals Installer ────────────────────────────────────────
# Idempotent: safe to run multiple times.
# Sets up:
#   1. Directories for signals and digests
#   2. Symlink for signal-tagger entry point
#   3. Claude Code SessionEnd hook in settings.json
#   4. launchd plist for daily analysis

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SIGNALS_DIR="$HOME/.claude/signals"
SIGNALS_HISTORY_DIR="$HOME/.claude/history/signals"
DIGESTS_DIR="$HOME/.claude/history/signals/digests"
SETTINGS_FILE="$HOME/.claude/settings.json"
PLIST_LABEL="com.session-signals.daily-analysis"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$PLIST_LABEL.plist"

# ── Colors ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[install]${NC} $1"; }
warn()  { echo -e "${YELLOW}[install]${NC} $1"; }
error() { echo -e "${RED}[install]${NC} $1" >&2; }

# ── Prerequisite checks ─────────────────────────────────────────────

check_prerequisites() {
  local missing=0

  if ! command -v bun &>/dev/null; then
    error "bun is not installed. Install it: https://bun.sh"
    missing=1
  fi

  if ! command -v ollama &>/dev/null; then
    warn "ollama is not installed. Pattern analysis requires it: https://ollama.com"
    warn "The signal tagger will still work without ollama."
  fi

  if [[ $missing -eq 1 ]]; then
    exit 1
  fi
}

# ── Directory setup ──────────────────────────────────────────────────

setup_directories() {
  info "Creating directories..."

  mkdir -p "$SIGNALS_DIR"
  mkdir -p "$SIGNALS_HISTORY_DIR"
  mkdir -p "$DIGESTS_DIR"
  mkdir -p "$HOME/.claude"

  info "Directories ready."
}

# ── Symlink signal-tagger ────────────────────────────────────────────

setup_symlink() {
  local source="$PROJECT_DIR/src/signal-tagger.ts"
  local target="$SIGNALS_DIR/signal-tagger.ts"

  if [[ -L "$target" ]]; then
    local existing
    existing="$(readlink "$target")"
    if [[ "$existing" == "$source" ]]; then
      info "Symlink already exists and is correct."
      return
    fi
    warn "Symlink exists but points to $existing — updating."
    rm "$target"
  elif [[ -f "$target" ]]; then
    warn "Regular file exists at $target — replacing with symlink."
    rm "$target"
  fi

  ln -s "$source" "$target"
  chmod +x "$source"
  info "Symlinked signal-tagger.ts"
}

# ── Claude Code hook registration ────────────────────────────────────

setup_hook() {
  local hook_command="$SIGNALS_DIR/signal-tagger.ts"

  # Create settings.json if it doesn't exist
  if [[ ! -f "$SETTINGS_FILE" ]]; then
    echo '{}' > "$SETTINGS_FILE"
    info "Created $SETTINGS_FILE"
  fi

  # Use bun to safely merge the hook entry (non-destructive)
  SETTINGS_PATH="$SETTINGS_FILE" HOOK_CMD="$hook_command" bun -e "
    const fs = require('fs');
    const path = process.env.SETTINGS_PATH;
    const hookCmd = process.env.HOOK_CMD;

    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
    } catch {
      settings = {};
    }

    // Ensure hooks.SessionEnd exists
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.SessionEnd) {
      settings.hooks.SessionEnd = [];
    }

    // Check if our hook is already registered
    const existing = settings.hooks.SessionEnd.find(
      (entry) => entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
    );

    if (existing) {
      console.log('[install] SessionEnd hook already registered.');
      process.exit(0);
    }

    // Add our hook entry
    settings.hooks.SessionEnd.push({
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: hookCmd,
          timeout: 15,
        },
      ],
    });

    fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    console.log('[install] SessionEnd hook registered in settings.json');
  "
}

# ── launchd plist ────────────────────────────────────────────────────

setup_launchd() {
  local bun_path
  bun_path="$(command -v bun)"
  local analyzer_path="$PROJECT_DIR/src/pattern-analyzer.ts"
  local log_dir="$HOME/Library/Logs/session-signals"
  mkdir -p "$log_dir"
  local log_path="$log_dir/session-signals.log"
  local error_log_path="$log_dir/session-signals-error.log"

  mkdir -p "$PLIST_DIR"

  # Unload existing plist if loaded (ignore errors)
  if launchctl list "$PLIST_LABEL" &>/dev/null; then
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    info "Unloaded existing plist."
  fi

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$bun_path</string>
        <string>$analyzer_path</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>0</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$log_path</string>
    <key>StandardErrorPath</key>
    <string>$error_log_path</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:$(dirname "$bun_path")</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
PLIST

  launchctl load "$PLIST_FILE"
  info "launchd plist installed and loaded."
  info "Daily analysis will run at midnight."
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
  info "Session Signals Installer"
  info "Project: $PROJECT_DIR"
  echo ""

  check_prerequisites
  setup_directories
  setup_symlink
  setup_hook
  setup_launchd

  echo ""
  info "Installation complete!"
  info ""
  info "What was set up:"
  info "  - Signal tagger: $SIGNALS_DIR/signal-tagger.ts"
  info "  - Claude Code hook: SessionEnd in $SETTINGS_FILE"
  info "  - Daily analysis: $PLIST_FILE (runs at midnight)"
  info "  - Signal data: $SIGNALS_HISTORY_DIR/"
  info "  - Digest output: $DIGESTS_DIR/"
  info ""
  info "To uninstall: $SCRIPT_DIR/uninstall.sh"
}

main "$@"
