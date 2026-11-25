# Trail Train.app — the dashboard as a launchable Mac app

Two bundles, built and installed to `/Applications` by `./build-app.sh`:

- **Trail Train.app** — the Dock face. Launch it: the server starts and the
  dashboard opens at **http://localhost:38100** (a fixed, deliberately
  unusual port with `strictPort`, so no collisions with other Vite projects
  and no silent port-hopping). The icon stays in the Dock while the server runs;
  a click while it runs brings back the dashboard's existing Chrome tab
  (see Chrome tab reuse below); **right-click → Quit stops the
  server**. If the server dies externally, the icon quits itself so the Dock
  never lies about what is running.
- **Trail Train Server.app** — faceless helper that actually owns the dev
  server process. Exists because of two macOS privacy-layer behaviors, found
  the hard way (the repo lives under `~/Documents`, which is TCC-protected):
  a server detached straight from the launcher applet loses its permission
  attribution and dies with a silent `EPERM`, and several helper shapes are
  denied without ever being shown a permission prompt. The shell-script
  helper bundle is the shape that verifiably works on this machine.

Rebuild after editing `TrailTrain.applescript`, `server-runner.sh`, or the
icon: `./macos/build-app.sh`. The `.app` bundles are build products and are
not committed; `icon.html` is the icon source and `icon-1024.png` the
rendered master it builds the icns ladder from.

Troubleshooting: the server logs to `~/Library/Logs/TrailTrain.log`. If it
shows `EPERM` / "current working directory must be readable", macOS is
denying the helper access to Documents — grant **Trail Train Server** access
under System Settings → Privacy & Security → Files and Folders (or Full
Disk Access), then relaunch. Paths are hardcoded for this machine's repo
location; this is a personal launcher, not a distributable.

## Port

The dev server is pinned to **38100** (`strictPort`). **A fresh launch of
the app restarts the server:** if this checkout's vite is already on the
port (a manual `npm run dev`, or a server that outlived its Dock icon), it
is stopped (TERM, then KILL after 10 s) and the app starts its own, so
quitting and reopening the app always runs the current code. Only a process
matching the launcher's kill pattern (this checkout's `vite`, not
`vite build`/`preview`) is stopped; a worktree's server or any other process
on the port is never touched. A click while the app is already running only
focuses the tab.

## Chrome tab reuse

Clicking the icon while Trail Train is already open brings back the Chrome tab
you were using (any tab whose URL starts with the app's localhost URL)
instead of opening a new one; with no such tab it opens one. This needs
Automation access to Google Chrome: the first click after a build asks for
it. If clicks keep opening new tabs, look in `~/Library/Logs/TrailTrain.log`
for a `[launcher] Chrome tab focus failed` line; `-1743` means the access
was refused — enable it under System Settings → Privacy & Security →
Automation, or `tccutil reset AppleEvents <bundle id>` and click again.
An ad-hoc rebuild changes the app's code identity, so macOS may ask again.

While a test or automation Chrome is running (the Playwright MCP's, whose
profile is under `~/Library/Caches/ms-playwright*`, or any Chrome started
with `--remote-debugging-pipe` or `--remote-debugging-port`), the launcher
doesn't script Chrome at all: AppleScript can't tell that instance from
yours, and a tab there has no real microphone or speakers. It hands the URL
to your own Chrome with `open -n -a 'Google Chrome' --args <url>` instead,
which always makes a new tab. Close the test browser and clicks reuse the tab
again.
