import { defineConfig, devices } from '@playwright/test'

/**
 * `npm run test:ui` — the browser half of Basecamp's tests.
 *
 * Run from web/: `npx playwright test -c tests/playwright.config.ts`.
 *
 * The server is not started by playwright's own `webServer` option: the port
 * is chosen at run time (never 38100, the developer's own dev server) and the
 * project root is a temp directory that has to exist before vite starts, so
 * both live in tests/setup/global-setup.ts.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './setup/global-setup.ts',

  // One server, one project root, one worker. The flows under test write to
  // that root — activating a race rewrites config/active-race.json, saving the
  // review rewrites a race.json — so running them concurrently would be
  // testing a race condition nobody has, not the app.
  workers: 1,
  fullyParallel: false,

  // A hang is a failure, and an 8-minute default timeout hides it until CI
  // gives up. Every flow here is a handful of clicks against a local server.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  globalTimeout: 90_000,

  // No retries: a flaky assertion in this suite is a bug report, not something
  // to paper over. `forbidOnly` keeps a stray `test.only` out of a commit.
  retries: 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    ...devices['Desktop Chrome'],
    // baseURL is overridden per test in tests/basecamp.ts — the real one is
    // only known once global setup has picked a free port.
    baseURL: 'http://127.0.0.1:0',
    viewport: { width: 1440, height: 900 },
    // Framer Motion animates the race menu and the vitals tiles in. Nothing
    // here asserts on an animation, and a half-faded element is the classic
    // source of a flaky click.
    reducedMotion: 'reduce',
    // No trace. `retain-on-failure` made Playwright 1.63's trace writer race
    // its own artifact cleanup at context close (`browserContext.close:
    // ENOENT … .playwright-artifacts-0/traces/resources/*.jsonl`), which
    // aborted the worker and left 20+ tests "did not run" roughly one run in
    // five — twice in one afternoon on unrelated tests (a11y's new-race
    // dialog, topline's build-note switch), never reproducible alone. With
    // retries at 0 a trace was rarely opened anyway; the failure screenshot
    // and error-context.md stay, and check:races must be deterministic.
    trace: 'off',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop',
      testIgnore: /race-day\.spec\.ts/,
    },
    {
      // Race-day mode is the phone view: it renders full-bleed, with no
      // command bar, and is explicitly designed to fit 360 px. Testing it at
      // 1440 would exercise a layout no runner ever sees.
      name: 'phone',
      testMatch: /race-day\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
  ],
})
