import { defineConfig, devices } from '@playwright/test'
import { statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const baseURL = process.env.LIVE_BASE_URL
const storageState = process.env.LIVE_STORAGE_STATE

if (!baseURL || !storageState) {
  throw new Error('LIVE_BASE_URL and LIVE_STORAGE_STATE are required for live tests')
}
const liveUrl = new URL(baseURL)
if (liveUrl.origin !== 'https://grooop-party-pwa.mirsella.workers.dev') {
  throw new Error('LIVE_BASE_URL must be the production Grooop Client HTTPS origin')
}
const statePath = resolve(storageState)
const repository = resolve(import.meta.dirname)
const pathFromRepository = relative(repository, statePath)
if (!isAbsolute(storageState) || (!pathFromRepository.startsWith('..') && pathFromRepository !== '')) {
  throw new Error('LIVE_STORAGE_STATE must be an absolute path outside the repository')
}
if ((statSync(statePath).mode & 0o777) !== 0o600) {
  throw new Error('LIVE_STORAGE_STATE must have mode 0600')
}

export default defineConfig({
  testDir: './tests/live',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 180_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    storageState: statePath,
    trace: 'off',
  },
})
