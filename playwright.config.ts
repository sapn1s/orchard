/**
 * Playwright adoption (FEAT-033 verdict: KEEP, opt-in per UI-bearing project —
 * claude-station IS one). This config REUSES the system Brave binary via
 * `launchOptions.executablePath` so `npx playwright install` / any automatic
 * Chromium fetch is never needed — zero browser download, ever, on this
 * machine (see docs/bugs/FEAT-033-tool-adoption-pipeline.md, verdict 3/3).
 *
 * Journeys live in scripts/qa/*.spec.ts. Each spec spawns its OWN scratch
 * server on an OS-assigned free port (never :4317, the live systemd
 * service — see docs/bugs/README.md's hard rule) and tears it down by PID,
 * never pkill. Run with `npm run qa:sweep`.
 */
import { defineConfig, devices } from '@playwright/test';

// Overridable for machines where Brave lives elsewhere; defaults to the path
// this repo's other verify-*.mjs scripts already assume is on PATH.
const BRAVE_PATH = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';

export default defineConfig({
  testDir: './scripts/qa',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    launchOptions: {
      executablePath: BRAVE_PATH,
    },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
