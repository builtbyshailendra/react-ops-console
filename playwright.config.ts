import { defineConfig } from '@playwright/test'

// Runs on the installed Microsoft Edge (no browser download). The server is
// the real one, built fresh, with an in-memory database so every run starts
// from the same seeded incidents.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 40_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8099',
    channel: 'msedge',
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
