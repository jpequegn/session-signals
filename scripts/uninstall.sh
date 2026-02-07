#!/usr/bin/env bash
set -euo pipefail

# ── Session Signals Uninstaller ──────────────────────────────────────
# Removes all session-signals integrations.
# Does NOT delete signal history data unless --purge is passed.

SIGNALS_DIR="$HOME/.claude/signals"
SETTINGS_FILE="$HOME/.claude/settings.json"
PLIST_LABEL="com.session-signals.daily-analysis"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$PLIST_LABEL.plist"

PURGE=false
for arg in "$@"; do
  if [[ "$arg" == "--purge" ]]; then
    PURGE=true
  fi
done

# ── Colors ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[uninstall]${NC} $1"; }
warn()  { echo -e "${YELLOW}[uninstall]${NC} $1"; }

# ── Unload and remove launchd plist ──────────────────────────────────

remove_launchd() {
  if [[ -f "$PLIST_FILE" ]]; then
    if launchctl list "$PLIST_LABEL" &>/dev/null; then
      launchctl unload "$PLIST_FILE" 2>/dev/null || true
      info "Unloaded launchd plist."
    fi
    rm "$PLIST_FILE"
    info "Removed $PLIST_FILE"
  else
    info "No launchd plist found."
  fi
}

# ── Remove symlink ───────────────────────────────────────────────────

remove_symlink() {
  local target="$SIGNALS_DIR/signal-tagger.ts"
  if [[ -L "$target" || -f "$target" ]]; then
    rm "$target"
    info "Removed signal-tagger symlink."
  else
    info "No signal-tagger symlink found."
  fi

  # Remove signals dir if empty
  if [[ -d "$SIGNALS_DIR" ]] && [[ -z "$(ls -A "$SIGNALS_DIR")" ]]; then
    rmdir "$SIGNALS_DIR"
    info "Removed empty $SIGNALS_DIR"
  fi
}

# ── Remove hook from settings.json ───────────────────────────────────

remove_hook() {
  if [[ ! -f "$SETTINGS_FILE" ]]; then
    info "No settings.json found."
    return
  fi

  # Check if bun is available for JSON manipulation
  if ! command -v bun &>/dev/null; then
    warn "bun not available — cannot safely modify settings.json."
    warn "Manually remove the signal-tagger hook entry from $SETTINGS_FILE"
    return
  fi

  SETTINGS_PATH="$SETTINGS_FILE" HOOK_FILTER="signal-tagger" bun -e "
    const fs = require('fs');
    const path = process.env.SETTINGS_PATH;
    const hookFilter = process.env.HOOK_FILTER;

    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
    } catch {
      console.log('[uninstall] Could not parse settings.json, skipping hook removal.');
      process.exit(0);
    }

    if (!settings.hooks?.SessionEnd) {
      console.log('[uninstall] No SessionEnd hooks found.');
      process.exit(0);
    }

    const before = settings.hooks.SessionEnd.length;
    settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
      (entry) => !entry.hooks?.some((h) => h.command?.includes(hookFilter))
    );
    const after = settings.hooks.SessionEnd.length;

    if (before === after) {
      console.log('[uninstall] No ' + hookFilter + ' hook found in SessionEnd.');
      process.exit(0);
    }

    // Clean up empty arrays/objects
    if (settings.hooks.SessionEnd.length === 0) {
      delete settings.hooks.SessionEnd;
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    console.log('[uninstall] Removed ' + hookFilter + ' hook from settings.json');
  "
}

# ── Purge data ───────────────────────────────────────────────────────

purge_data() {
  if [[ "$PURGE" != true ]]; then
    info "Signal history data preserved. Use --purge to remove."
    return
  fi

  local signals_history="$HOME/.claude/history/signals"
  if [[ -d "$signals_history" ]]; then
    rm -rf "$signals_history"
    info "Purged signal history data."
  fi

  local log_dir="$HOME/Library/Logs/session-signals"
  if [[ -d "$log_dir" ]]; then
    rm -rf "$log_dir"
    info "Removed log directory."
  fi
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
  info "Session Signals Uninstaller"
  echo ""

  remove_launchd
  remove_symlink
  remove_hook
  purge_data

  echo ""
  info "Uninstall complete."
  if [[ "$PURGE" != true ]]; then
    info "Signal history preserved at ~/.claude/history/signals/"
    info "Run with --purge to remove all data."
  fi
}

main "$@"
