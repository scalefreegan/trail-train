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
