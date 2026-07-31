import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimDailyAds } from '../../worker/ads'
import worker from '../../worker/index'
import { seedAccount } from './helpers'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function runTimersImmediately(): ReturnType<typeof vi.fn> {
  const waits = vi.fn()
  vi.stubGlobal('setTimeout', (callback: TimerHandler, milliseconds?: number) => {
    waits(milliseconds)
    if (typeof callback === 'function') callback()
    return 1
  })
  return waits
}

describe('daily ad claiming', () => {
  it('claims every remaining ad for active accounts in parallel and persists each balance', async () => {
    await Promise.all([
      seedAccount({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'one@example.com',
        sessionId: 'session-one',
        userId: 101,
      }),
      seedAccount({
        id: '22222222-2222-4222-8222-222222222222',
        email: 'two@example.com',
        sessionId: 'session-two',
        userId: 202,
      }),
      seedAccount({
        id: '33333333-3333-4333-8333-333333333333',
        email: 'old@example.com',
        sessionId: 'expired-session',
        userId: 303,
        status: 'reauth-required',
      }),
    ])
    const waits = runTimersImmediately()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const paths = new Map<string, string[]>()
    let stateRequests = 0
    let releaseStates: (() => void) | undefined
    const bothStatesRequested = new Promise<void>((resolve) => {
      releaseStates = resolve
    })
    const starts = new Map<string, number>()

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const session = new Headers(init?.headers).get('bearer') ?? ''
      paths.set(session, [...(paths.get(session) ?? []), path])
      if (path.endsWith('/ads/state')) {
        stateRequests += 1
        if (stateRequests === 2) releaseStates?.()
        await bothStatesRequested
        return Response.json({
          adsConfig: { userWatchedVideosToday: 1, totalWatchableVideos: 3 },
        })
      }
      if (path.endsWith('/ads/start')) {
        const ad = (starts.get(session) ?? 0) + 1
        starts.set(session, ad)
        return Response.json({ token: `${session}-token-${ad}` })
      }
      if (path.includes('/ads/finished/')) {
        const ad = Number(path.at(-1))
        return Response.json({
          status: 'success',
          balance: { grooopies: (session === 'session-one' ? 1_000 : 2_000) + ad * 100 },
        })
      }
      throw new Error(`Unexpected Grooop request: ${path}`)
    }))

    await claimDailyAds(env)

    expect(paths.get('session-one')).toEqual([
      '/api/1.0/ads/state',
      '/api/1.0/ads/start',
      '/api/1.0/ads/finished/session-one-token-1',
      '/api/1.0/ads/start',
      '/api/1.0/ads/finished/session-one-token-2',
    ])
    expect(paths.get('session-two')).toEqual([
      '/api/1.0/ads/state',
      '/api/1.0/ads/start',
      '/api/1.0/ads/finished/session-two-token-1',
      '/api/1.0/ads/start',
      '/api/1.0/ads/finished/session-two-token-2',
    ])
    expect(paths.has('expired-session')).toBe(false)
    expect(waits.mock.calls).toEqual([[20_000], [20_000], [20_000], [20_000]])
    expect(await env.DB.prepare(
      'SELECT id, grooopies FROM accounts ORDER BY id',
    ).all()).toMatchObject({
      results: [
        { id: '11111111-1111-4111-8111-111111111111', grooopies: 1_200 },
        { id: '22222222-2222-4222-8222-222222222222', grooopies: 2_200 },
        { id: '33333333-3333-4333-8333-333333333333', grooopies: 1_000 },
      ],
    })
  })

  it('does not retry an unsuccessful finish or persist its ambiguous balance', async () => {
    const accountId = '11111111-1111-4111-8111-111111111111'
    await seedAccount({
      id: accountId,
      email: 'one@example.com',
      sessionId: 'session-one',
      userId: 101,
      grooopies: 500,
    })
    runTimersImmediately()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      requested.push(path)
      if (path.endsWith('/ads/state')) {
        return Response.json({ adsConfig: { userWatchedVideosToday: 0, totalWatchableVideos: 1 } })
      }
      if (path.endsWith('/ads/start')) return Response.json({ token: 'one-token' })
      if (path.endsWith('/ads/finished/one-token')) {
        return Response.json({ status: 'pending', balance: { grooopies: 600 } })
      }
      throw new Error(`Unexpected Grooop request: ${path}`)
    }))

    await claimDailyAds(env)

    expect(requested).toEqual([
      '/api/1.0/ads/state',
      '/api/1.0/ads/start',
      '/api/1.0/ads/finished/one-token',
    ])
    expect(await env.DB.prepare('SELECT grooopies FROM accounts WHERE id = ?')
      .bind(accountId).first()).toEqual({ grooopies: 500 })
    expect(errorLog).toHaveBeenCalledWith('Grooop ads response failed validation', {
      operation: 'finish',
    })
    expect(errorLog).toHaveBeenCalledWith('Daily Grooop ad claim failed', {
      accountId,
      code: 'grooop-invalid-response',
    })
  })

  it.each([
    {
      operation: 'state',
      state: { adsConfig: { userWatchedVideosToday: '0', totalWatchableVideos: 1 } },
      expectedPaths: ['/api/1.0/ads/state'],
    },
    {
      operation: 'start',
      state: { adsConfig: { userWatchedVideosToday: 0, totalWatchableVideos: 1 } },
      expectedPaths: ['/api/1.0/ads/state', '/api/1.0/ads/start'],
    },
  ])('rejects an invalid $operation response before the next mutation', async ({
    operation,
    state,
    expectedPaths,
  }) => {
    const accountId = '11111111-1111-4111-8111-111111111111'
    await seedAccount({
      id: accountId,
      email: 'one@example.com',
      sessionId: 'session-one',
      userId: 101,
      grooopies: 500,
    })
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      requested.push(path)
      if (path.endsWith('/ads/state')) return Response.json(state)
      if (path.endsWith('/ads/start')) return Response.json({ token: null })
      throw new Error(`Unexpected Grooop request: ${path}`)
    }))

    await claimDailyAds(env)

    expect(requested).toEqual(expectedPaths)
    expect(errorLog).toHaveBeenCalledWith('Grooop ads response failed validation', { operation })
    expect(await env.DB.prepare('SELECT grooopies FROM accounts WHERE id = ?')
      .bind(accountId).first()).toEqual({ grooopies: 500 })
  })

  it('marks only canonical unauthorized responses for reauthentication without a user preflight', async () => {
    const accountId = '11111111-1111-4111-8111-111111111111'
    await seedAccount({
      id: accountId,
      email: 'one@example.com',
      sessionId: 'expired-session',
      userId: 101,
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).pathname).toBe('/api/1.0/ads/state')
      return Response.json({ status: 'unauthorized' }, { status: 403 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await claimDailyAds(env)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await env.DB.prepare('SELECT status FROM accounts WHERE id = ?')
      .bind(accountId).first()).toEqual({ status: 'reauth-required' })
    expect(warning).toHaveBeenCalledWith(
      'Grooop session rejected; marking account for reauthentication',
      { accountId },
    )
  })

  it('registers the daily claim with the scheduled execution context', async () => {
    const waitUntil = vi.fn()
    await worker.scheduled(
      {} as ScheduledController,
      env,
      { waitUntil } as unknown as ExecutionContext,
    )

    expect(waitUntil).toHaveBeenCalledOnce()
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined()
  })
})
