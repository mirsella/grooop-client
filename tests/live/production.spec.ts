import { expect, test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

test('authenticated production shell and API expose no credentials', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: /LET’S PLAY/i })).toBeVisible()
  const health = await page.request.get('/api/health')
  expect(health.ok()).toBe(true)
  expect(await health.json()).toMatchObject({ status: 'ok', environment: 'production' })
  expect(await page.locator('body').innerText()).not.toMatch(/sessionId|grooop=/i)
  expect(errors).toEqual([])
})

test('completes one explicitly authorized, capped Proximo round', async ({ page }) => {
  test.skip(process.env.LIVE_ALLOW_SPEND !== '1', 'Set LIVE_ALLOW_SPEND=1 to authorize a paid party')
  const spendCap = Number(process.env.LIVE_SPEND_CAP)
  expect(Number.isSafeInteger(spendCap) && spendCap > 0, 'LIVE_SPEND_CAP must be a positive integer').toBe(true)

  await page.goto('/')
  await page.getByRole('button', { name: 'Quote match' }).click()
  const quotedText = await page.locator('.cost b').innerText()
  const quotedCost = Number.parseInt(quotedText, 10)
  expect(Number.isSafeInteger(quotedCost)).toBe(true)
  expect(quotedCost).toBeLessThanOrEqual(spendCap)

  await page.getByRole('button', { name: 'Create match →' }).click()
  await expect(page.getByText('Live connection')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Start Proximo' })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Start Proximo' }).click()
  await page.getByRole('button', { name: 'Ready' }).click()
  await expect(page.getByRole('spinbutton', { name: 'Team A answer' })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('spinbutton', { name: 'Team A answer' }).fill('0')
  await page.getByRole('spinbutton', { name: 'Team B answer' }).fill('0')
  await page.getByRole('button', { name: 'Lock both answers' }).click()
  await expect(page.getByText('Official answer')).toBeVisible({ timeout: 60_000 })
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'End match' }).click()
  await expect(page.getByText('This match is closed. Its result remains in History.')).toBeVisible({ timeout: 60_000 })
})
