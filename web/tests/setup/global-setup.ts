import { FAKE_AGENT_FILE, freePort, makeProjectRoot, startServer } from '../launch.mjs'

/**
 * Build the throwaway project root and start one vite against it for the whole
 * run, then hand the workers its address through the environment.
 *
 * Playwright spawns its workers after global setup returns, so an env var set
 * here is inherited by every one of them — which is the only way to get a
 * port that was not known when playwright.config.ts was evaluated into
 * `use.baseURL`. web/tests/basecamp.ts reads it back.
 *
 * TRAIL_FAKE_AGENT is set for the whole run, pointing at the canned stage-1
 * reply in tests/fixtures/agent/. It is what makes the refresh flow testable —
 * and, more importantly, it is what guarantees no test can ever spawn the real
 * `claude` CLI: agent-run.mjs short-circuits on the env var before it reaches
 * a spawn, and treats an unreadable file as a hard error rather than falling
 * back to one.
 *
 * One server, not one per worker: the flows write to the same project root
 * (the race pointer, a saved race.json), so a second server on a second root
 * would only make the suite lie about what it is testing. The specs are
 * serialised for the same reason — see `workers: 1` in the config.
 */
export default async function globalSetup() {
  // The port is picked BEFORE the root is built, not inside startServer: one
  // fixture race's links.site has to point at a page this very server will
  // serve (see `siteFixture` in launch.mjs), so the base URL has to be known
  // while the race.json is being written.
  const port = await freePort()
  const root = await makeProjectRoot({ siteBase: `http://127.0.0.1:${port}` })
  const server = await startServer({ root, port, fakeAgentFile: FAKE_AGENT_FILE })
  process.env.TRAIL_TEST_BASE_URL = server.baseURL
  process.env.TRAIL_TEST_PROJECT_ROOT = root

  // Returned teardown: playwright runs it once every test has finished, and
  // the temp root goes with it. A leaked vite would hold its port and, worse,
  // keep a file watcher on the developer's checkout.
  return async () => {
    await server.stop()
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
