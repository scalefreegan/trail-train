# Basecamp.app — the dashboard as a launchable Mac app

Two bundles, built and installed to `~/Applications` by `./build-app.sh`:

- **Basecamp.app** — the Dock face. Launch it: the server starts and the
  dashboard opens at **http://localhost:38100** (fixed port — 38 h cutoff ·
  100 miles — `strictPort`, so no collisions with other Vite projects and no
  silent port-hopping). The icon stays in the Dock while the server runs;
  double-click focuses the dashboard; **right-click → Quit stops the
  server**. If the server dies externally, the icon quits itself so the Dock
  never lies about what is running.
- **Basecamp Server.app** — faceless helper that actually owns the dev
  server process. Exists because of two macOS privacy-layer behaviors, found
  the hard way (the repo lives under `~/Documents`, which is TCC-protected):
  a server detached straight from the launcher applet loses its permission
  attribution and dies with a silent `EPERM`, and several helper shapes are
  denied without ever being shown a permission prompt. The shell-script
  helper bundle is the shape that verifiably works on this machine.

Rebuild after editing `Basecamp.applescript`, `server-runner.sh`, or the
icon: `./macos/build-app.sh`. The `.app` bundles are build products and are
not committed; `icon.html` is the icon source and `icon-1024.png` the
rendered master it builds the icns ladder from.

Troubleshooting: the server logs to `~/Library/Logs/Basecamp.log`. If it
shows `EPERM` / "current working directory must be readable", macOS is
denying the helper access to Documents — grant **Basecamp Server** access
under System Settings → Privacy & Security → Files and Folders (or Full
Disk Access), then relaunch. Paths are hardcoded for this machine's repo
location; this is a personal launcher, not a distributable.
