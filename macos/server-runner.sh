#!/bin/zsh
# Executable of "Basecamp Server.app" (LSUIElement — faceless). Runs the dev
# server with this process as its parent. This exact shape is the one that
# empirically survives macOS's ~/Documents privacy layer for this repo —
# a compiled-applet variant of the same bundle was silently denied.
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
