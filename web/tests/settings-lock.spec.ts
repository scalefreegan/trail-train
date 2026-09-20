import { test, expect } from './basecamp'

/**
 * PR #24 review round 3, server sweep finding: PUT /api/settings does a
 * read-modify-write across config/state.json (and, when a payload's
 * calendar/physiology/goals section is present, config/profile.json /
 * config/goals.json too) with no serialization — two concurrent PUTs (the
 * settings dialog open in two tabs, or a double-submit) would both read the
 * same pre-write state and the second's merge would silently drop the
 * first's edit.
 *
 * Fixed with SETTINGS_LOCK_KEY, the same acquireSlugLock/releaseSlugLock
 * primitive ACTIVATE_LOCK_KEY already uses to serialize concurrent writes to
 * config/active-race.json (also a single shared file, not per-race). The
 * loser gets a 409 rather than queuing — same policy as activation, and for
 * the same reason: a settings PUT racing another one is stale the instant
 * it loses, so silently overwriting whichever won would just reproduce the
 * lost-update bug this fixes.
 */
test('two concurrent PUT /api/settings serialize: one 200, one 409', async ({ request }) => {
  const [a, b] = await Promise.all([
    request.put('/api/settings', { data: {} }),
    request.put('/api/settings', { data: {} }),
  ])

  const statuses = [a.status(), b.status()].sort((x, y) => x - y)
  expect(statuses).toEqual([200, 409])

  const loser = a.status() === 409 ? a : b
  const winner = a.status() === 409 ? b : a
  expect((await loser.json()).error).toMatch(/settings save is already in progress/i)
  // the winner's write actually completed — not just "not the loser"
  expect((await winner.json()).preferences).toBeTruthy()
})

/**
 * PR #24 review round 4, MEDIUM finding: unlike raceSwitchApi/ACTIVATE_LOCK_KEY
 * (the lock's own precedent) and every other body-reading route in
 * web/vite.config.ts, settingsApi's PUT read its body with no BODY_MAX_BYTES
 * cap at all — and it did so *inside* SETTINGS_LOCK_KEY, so a multi-MB body
 * would be fully buffered and JSON.parsed while holding the one lock every
 * other settings save must wait on. Fixed by capping the read (413 before
 * JSON.parse, same streamed shape as the siblings) and moving it entirely
 * BEFORE acquireSlugLock, so an oversized request never holds the lock.
 */
test('an oversize PUT /api/settings body is refused with 413, before it is ever parsed', async ({ request }) => {
  // just over the 512 KB cap
  const big = 'x'.repeat(512 * 1024 + 4096)
  const res = await request.put('/api/settings', { data: { preferences: { training_philosophy: big } } })
  expect(res.status()).toBe(413)
})

test('a concurrent normal PUT /api/settings is not blocked by an oversize one', async ({ request }) => {
  const big = 'x'.repeat(512 * 1024 + 4096)
  const [oversize, normal] = await Promise.all([
    request.put('/api/settings', { data: { preferences: { training_philosophy: big } } }),
    request.put('/api/settings', { data: {} }),
  ])
  // the oversize request is refused at the body cap, not the lock — it must
  // never 409 the normal save, and the normal save must actually complete
  expect(oversize.status()).toBe(413)
  expect(normal.status()).toBe(200)
  expect((await normal.json()).preferences).toBeTruthy()
})
