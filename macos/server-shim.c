// The helper's executable: a real Mach-O binary that execs the runner script.
//
// It exists for exactly one reason. macOS 26.6.2 stopped attributing TCC to
// app bundles whose CFBundleExecutable is an interpreted script: the running
// process is /bin/zsh — an Apple platform binary — which can neither hold nor
// prompt for a per-app grant, so every ~/Documents access is denied silently
// (no prompt, and a manually added Full Disk Access row never matches the
// accessor). Measured on this machine 2026-08-29, in wine-guide, where the
// same helper shape (lifted from this repo) died the first time its grant was
// re-established post-update; Basecamp's survived only because tccd kept
// honoring the pre-update grant row. Before that update the script-executable
// shape was the one that worked — this doctrine has now inverted once in each
// direction. A compiled shim gives tccd a promptable identity again, and
// everything else about the helper (blocking child, TCC-safe cwd) stays in
// the script it execs.
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  char exe[PATH_MAX];
  uint32_t n = sizeof exe;
  if (_NSGetExecutablePath(exe, &n) != 0) return 1;
  char dir[PATH_MAX];
  strlcpy(dir, exe, sizeof dir); // dirname may scribble on its argument
  char script[PATH_MAX];
  snprintf(script, sizeof script, "%s/../Resources/server-runner.sh", dirname(dir));
  execl("/bin/zsh", "zsh", script, (char *)NULL);
  perror("basecamp server shim: execl /bin/zsh");
  return 127;
}
