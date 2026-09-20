import net from 'node:net'
import { test, expect } from '@playwright/test'
import { freePort, makeProjectRoot, startServer } from './launch.mjs'

/**
 * launch.mjs's freePort()/startServer() TOCTOU retry.
 *
 * r1-crew-tests.md LOW: the port is obtained by binding a probe socket to
 * port 0, reading the assigned port, and closing it before handing the
 * number to vite (`--strictPort`) — a real, acknowledged race in the gap
 * between that close and vite's own listen. On a busy box another process
 * can grab the exact port in that window, and vite exits non-zero rather
 * than hopping, surfacing as a flat "vite exited before it was ready" with
 * no indication it was a port race.
 *
 * This does not rely on timing to WIN the real race (that would be flaky in
 * both directions) — it manufactures the failure directly: a plain
 * `net.Server` pre-binds the exact port startServer is told to use, so
 * vite's first attempt is guaranteed to hit EADDRINUSE and exit early. The
 * squatter then releases the port shortly after — standing in for the
 * transient process that grabbed it in the real TOCTOU window — before the
 * bounded 300 ms retry delay elapses, so the SAME port is free again by the
 * second attempt.
 *
 * This is a Node-side test of launch.mjs's own retry logic, not a browser
 * flow — no `page` fixture, and no dependency on the shared server
 * global-setup.ts starts for the rest of the suite (a separate port, a
 * separate project root).
 */

test('startServer retries once on the same port after a transient squat, and gives up if it never clears', async () => {
  const root = await makeProjectRoot()
  const port = await freePort()

  // The squatter: binds the exact port vite is about to be told to use, so
  // the first attempt is guaranteed to hit EADDRINUSE and exit early. Stands
  // in for the process that can win the freePort() TOCTOU race for real.
  const squatter = net.createServer()
  await new Promise<void>((resolve, reject) => {
    squatter.on('error', reject)
    squatter.listen(port, '127.0.0.1', () => resolve())
  })

  // Held long enough that vite's OWN bind attempt (it detects EADDRINUSE and
  // exits within ~110-120ms of being spawned, measured directly) is
  // guaranteed to land while the squatter still holds the port, then
  // released with margin on both sides of that — well before the fix's
  // 300 ms retry pause elapses, so the second attempt lands on a genuinely
  // free port, the transient-squat case the fix targets.
  const releaseTimer = setTimeout(() => squatter.close(), 200)

  let server: Awaited<ReturnType<typeof startServer>> | null = null
  try {
    server = await startServer({ root, port })
    expect(server.port).toBe(port)
    const res = await fetch(`${server.baseURL}/`)
    expect(res.status).toBeLessThan(500)
  } finally {
    clearTimeout(releaseTimer)
    if (!squatter.listening) { /* already released */ } else squatter.close()
    if (server) await server.stop()
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('startServer still fails when the port never clears (the retry is bounded, not infinite)', async () => {
  const root = await makeProjectRoot()
  const port = await freePort()

  const squatter = net.createServer()
  await new Promise<void>((resolve, reject) => {
    squatter.on('error', reject)
    squatter.listen(port, '127.0.0.1', () => resolve())
  })

  try {
    // Never released — both the first attempt and the one bounded retry
    // must fail, and startServer must reject rather than hang or loop.
    await expect(startServer({ root, port })).rejects.toThrow(/vite exited/)
  } finally {
    squatter.close()
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
