import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/wind-tunnel/',
    channel: process.env.WT_BROWSER_CHANNEL,
    viewport: { width: 1440, height: 940 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm start',
    url: 'http://127.0.0.1:4173/wind-tunnel/',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
})
