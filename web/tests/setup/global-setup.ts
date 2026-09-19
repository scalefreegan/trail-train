import { makeProjectRoot, startServer } from '../launch.mjs'

/**
 * Build the throwaway project root and start one vite against it for the whole
 * run, then hand the workers its address through the environment.
 *
 * Playwright spawns its workers after global setup returns, so an env var set
 * here is inherited by every one of them — which is the only way to get a
 * port that was not known when playwright.config.ts was evaluated into
 * `use.baseURL`. web/tests/basecamp.ts reads it back.
 *
 * One server, not one per worker: the flows write to the same project root
 * (the race pointer, a saved race.json), so a second server on a second root
 * would only make the suite lie about what it is testing. The specs are
 * serialised for the same reason — see `workers: 1` in the config.
 */
export default async function globalSetup() {
  const root = await makeProjectRoot()
  const server = await startServer({ root })
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
