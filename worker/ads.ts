import { accountSecrets, withAccountSession } from './accounts'
import type { Env } from './env'
import { grooopRequest } from './grooop'
import { HttpError } from './http'

interface AdsConfig {
  userWatchedVideosToday: number
  totalWatchableVideos: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function invalidAdsResponse(operation: string): never {
  console.error('Grooop ads response failed validation', { operation })
  throw new HttpError(502, 'grooop-invalid-response', 'Grooop returned an invalid response')
}

function requireAdsConfig(value: unknown): AdsConfig {
  const config = record(record(value)?.adsConfig)
  const watched = config?.userWatchedVideosToday
  const total = config?.totalWatchableVideos
  if (
    !Number.isInteger(watched) || Number(watched) < 0 ||
    !Number.isInteger(total) || Number(total) < Number(watched)
  ) {
    return invalidAdsResponse('state')
  }
  return {
    userWatchedVideosToday: Number(watched),
    totalWatchableVideos: Number(total),
  }
}

function requireAdToken(value: unknown): string {
  const token = record(value)?.token
  if (typeof token !== 'string' || !token) {
    return invalidAdsResponse('start')
  }
  return token
}

function requireFinishedBalance(value: unknown): number {
  const response = record(value)
  const grooopies = record(response?.balance)?.grooopies
  if (
    response?.status !== 'success' ||
    typeof grooopies !== 'number' ||
    !Number.isFinite(grooopies)
  ) {
    return invalidAdsResponse('finish')
  }
  return grooopies
}

function waitForAd(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20_000))
}

async function claimForAccount(env: Env, accountId: string): Promise<void> {
  const { account, sessionId } = await accountSecrets(env, accountId)
  await withAccountSession(env, accountId, account, async () => {
    const config = requireAdsConfig(await grooopRequest<unknown>('ads/state', { sessionId }))
    const remaining = config.totalWatchableVideos - config.userWatchedVideosToday

    for (let ad = 1; ad <= remaining; ad++) {
      console.info('Starting Grooop ad mutation', { accountId, ad, total: remaining })
      const token = requireAdToken(await grooopRequest<unknown>('ads/start', {
        method: 'POST',
        sessionId,
      }))

      await waitForAd()

      console.info('Finishing Grooop ad mutation', { accountId, ad, total: remaining })
      const balance = requireFinishedBalance(await grooopRequest<unknown>(
        `ads/finished/${encodeURIComponent(token)}`,
        { method: 'POST', sessionId },
      ))

      const now = new Date().toISOString()
      await env.DB.prepare(
        'UPDATE accounts SET grooopies = ?, updated_at = ? WHERE id = ?',
      ).bind(balance, now, accountId).run()
      console.info('Grooop ad claim completed', { accountId, ad, total: remaining })
    }
  })
}

export async function claimDailyAds(env: Env): Promise<void> {
  const { results: accounts } = await env.DB.prepare(
    "SELECT id FROM accounts WHERE status = 'active'",
  ).all<{ id: string }>()

  const outcomes = await Promise.allSettled(
    accounts.map((account) => claimForAccount(env, account.id)),
  )
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') return
    const error = outcome.reason
    console.error('Daily Grooop ad claim failed', {
      accountId: accounts[index].id,
      code: error instanceof HttpError ? error.code : 'internal-error',
    })
  })
}
