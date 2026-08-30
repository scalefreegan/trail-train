#!/bin/zsh
# The real work of "Basecamp Server.app" (LSUIElement — faceless). Runs the
# dev server with this process as its parent. Since macOS 26.6.2 this script
# is NOT the bundle's executable — a compiled shim (server-shim.c) execs it,
# because tccd stopped attributing TCC to script-executable bundles (the
# process is /bin/zsh, a platform binary: silently denied, no prompt, and
# Full Disk Access rows never match). The shim carries the bundle identity;
# this script keeps the TCC-safe-cwd and blocking-child behavior.
# cd / first: the inherited cwd can be an unreadable Documents path, which
# makes every login-shell init (brew shellenv) and npm getcwd explode before
# the real work starts.
cd /
REPO="/Users/brooks/Documents/git/trail-train"
LOG="$HOME/Library/Logs/Basecamp.log"
: > "$LOG"
{
  echo "basecamp server starting $(date)"
  cd "$REPO/web" || { echo "cannot read $REPO — grant Basecamp Server access in System Settings > Privacy & Security > Files and Folders"; exit 1; }
  exec /bin/zsh -lc 'exec npm run dev'
} >> "$LOG" 2>&1 < /dev/null
