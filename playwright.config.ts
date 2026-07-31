import { defineConfig, devices, type Project } from '@playwright/test'

const projects: Project[] = [
  { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'pixel-chromium', use: { ...devices['Pixel 7'] } },
  { name: 'iphone-chromium', use: { ...devices['iPhone 15'], browserName: 'chromium' } },
]

if (process.env.PLAYWRIGHT_WEBKIT) {
  projects.push({ name: 'iphone-webkit', use: { ...devices['iPhone 15'] } })
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm build && pnpm preview --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects,
})
