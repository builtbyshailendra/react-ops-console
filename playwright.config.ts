import { defineConfig } from '@playwright/test'

// Runs on the installed Microsoft Edge by default (no browser download);
// PW_CHANNEL= (empty) uses Playwright's own Chromium, as CI does. The server
// is the real one, built fresh, with an in-memory database so every run
// starts from the same seeded incidents.
const channel = process.env.PW_CHANNEL ?? 'msedge'
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 40_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8099',
    channel: channel || undefined,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite build && node server/main.ts',
    url: 'http://127.0.0.1:8099/',
    env: { PORT: '8099', DB_PATH: ':memory:' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
