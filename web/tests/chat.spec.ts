/**
 * The coach chat turn — PRD v2 §6, and the last agent-backed flow to come
 * under the test seam.
 *
 * `/api/chat` is not `runClaudeJson`: the dashboard streams, so the handler in
 * web/vite.config.ts spawns `claude` itself. That made it the one flow a
 * browser test could not drive — until the handler learned the same
 * `TRAIL_FAKE_AGENT` seam scripts/agent-run.mjs has, which global setup points
 * at web/tests/fixtures/agent/. So the reply below is a file on disk and the
 * whole endpoint in front of it — the race_state validation, the facts digest,
 * the system prompt, the token measurement, the SSE framing — is the real
 * code.
 *
 * Two things are asserted, and they are the two that break silently:
 *
 *   · the reply reaches the rail. The SSE stream is parsed by hand in
 *     App.tsx (event/data lines, blank-line framed), and a mis-framed reply
 *     shows up as a bubble that never arrives rather than as an error.
 *   · the request carried `race_state`. It is built in the browser from the
 *     planner's own numbers and sent per turn; nothing on the server can tell
 *     that it stopped being sent, because the server renders no block for a
 *     turn without one and answers perfectly happily. So the POST body is read
 *     off the wire.
 *
 * Deliberately in VIEW mode. Generic mode sends no race state at all (PRD-v2
 * §6) and train mode is the obvious case; view mode — browsing a race that is
 * not the training target — is the one where the client has to send the race
 * ON SCREEN rather than the one in config/active-race.json.
 */

import { MM, expect, openDashboard, setActiveRace, test } from './basecamp'

/** A string that appears in the canned agent reply and nowhere in the app. */
const CANNED_MARKER = /Invented for tests · nowhere real/

test('a chat turn in view mode renders the reply and carries race_state', async ({ page, request, trouble }) => {
  // Browse the 100-miler read-only: the pointer's mode, not a different race.
  await setActiveRace(request, MM.slug, 'view')
  await openDashboard(page)

  // The coach rail is open by default (localStorage `rail.open`), and the
  // thread starts empty — the suggested-prompt chips are its resting state.
  const rail = page.locator('aside')
  await expect(rail.getByPlaceholder('ask the coach…')).toBeVisible()

  // Read the POST body off the wire. `request.postData()` is the raw string
  // the browser sent, so this asserts on what left the page rather than on
  // what a helper in the test rebuilt.
  const chatBodies: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/chat') {
      chatBodies.push(req.postData() ?? '')
    }
  })

  await rail.getByPlaceholder('ask the coach…').fill('how does this week look?')
  await rail.getByRole('button', { name: /^send/ }).click()

  // The turn lands: our own words, then the canned reply as the coach.
  await expect(rail.getByText('how does this week look?')).toBeVisible()
  await expect(rail.getByText(CANNED_MARKER)).toBeVisible()

  // …and the input is usable again, which is what says the stream reached
  // `done` rather than being left open by a handler that forgot to end it.
  await expect(rail.getByPlaceholder('ask the coach…')).toBeEnabled()

  expect(chatBodies, 'the send button did not POST /api/chat').toHaveLength(1)
  const body = JSON.parse(chatBodies[0]) as {
    messages?: { role: string; content: string }[]
    race_state?: { mode?: string; slug?: string }
  }
  expect(body.messages?.at(-1)?.content).toBe('how does this week look?')
  expect(body.race_state, 'no race_state on a turn with a race on screen').toBeTruthy()
  expect(body.race_state?.mode, 'the browsed race is view mode, not train').toBe('view')
  expect(body.race_state?.slug, 'race_state must name the race ON SCREEN').toBe(MM.slug)

  expect(trouble.all(), 'the chat turn logged something').toEqual([])
})
