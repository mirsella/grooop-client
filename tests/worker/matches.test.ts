import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../worker/env'
import { handleMatchesApi } from '../../worker/matches'
import { jsonRequest, seedAccount } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('match integration', () => {
  it('cancels a live match through its room and returns the projected terminal row', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    const matchId = '33333333-3333-4333-8333-333333333333'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    await env.DB.prepare(
      `INSERT INTO matches (
        id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
        game_mode, content_slug, duration_minutes, cost, created_at, updated_at
      ) VALUES (?, 'waiting', ?, ?, ?, ?, 'proximo', '300', 15, 40, ?, ?)`,
    ).bind(
      matchId,
      hostId,
      guestId,
      JSON.stringify({ name: 'Reds', roster: ['Alice'], accountId: hostId }),
      JSON.stringify({ name: 'Blues', roster: ['Bob'], accountId: guestId }),
      '2026-07-31T10:00:00.000Z',
      '2026-07-31T10:00:00.000Z',
    ).run()

    const cancel = vi.fn(async () => {
      const now = '2026-07-31T10:05:00.000Z'
      await env.DB.prepare("UPDATE matches SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, matchId).run()
      return Response.json({ status: 'cancelled' })
    })
    const fakeMatches = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: cancel })),
    } as unknown as DurableObjectNamespace
    const testEnv = { ...env, MATCHES: fakeMatches } as Env

    const response = await handleMatchesApi(
      jsonRequest(`/api/matches/${matchId}/cancel`, 'POST', {}),
      testEnv,
    )
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({ match: { id: matchId, status: 'cancelled' } })
    expect(cancel).toHaveBeenCalledWith('https://match.internal/internal/cancel', { method: 'POST' })

    const replay = await handleMatchesApi(
      jsonRequest(`/api/matches/${matchId}/cancel`, 'POST', {}),
      testEnv,
    )
    expect(await replay!.json()).toMatchObject({ match: { id: matchId, status: 'cancelled' } })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reconciles a live row when Grooop confirms that the lobby is gone', async () => {
    const hostId = '44444444-4444-4444-8444-444444444444'
    const guestId = '55555555-5555-4555-8555-555555555555'
    const matchId = '66666666-6666-4666-8666-666666666666'
    await seedAccount({ id: hostId, email: 'missing-host@example.com', sessionId: 'host', userId: 303 })
    await seedAccount({ id: guestId, email: 'missing-guest@example.com', sessionId: 'guest', userId: 404 })
    await env.DB.prepare(
      `INSERT INTO matches (
        id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
        game_mode, content_slug, duration_minutes, cost, created_at, updated_at
      ) VALUES (?, 'revealed', ?, ?, ?, ?, 'proximo', '300', 15, 40, ?, ?)`,
    ).bind(
      matchId,
      hostId,
      guestId,
      JSON.stringify({ name: 'Reds', roster: ['Alice'], accountId: hostId }),
      JSON.stringify({ name: 'Blues', roster: ['Bob'], accountId: guestId }),
      '2026-07-31T10:00:00.000Z',
      '2026-07-31T10:00:00.000Z',
    ).run()
    const fetch = vi.fn(async () => Response.json({
      error: 'party-socket-rejected',
      message: 'Grooop rejected the party connection: lobby-not-found',
    }, { status: 502 }))
    const testEnv = {
      ...env,
      MATCHES: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch })),
      } as unknown as DurableObjectNamespace,
    } as Env

    const response = await handleMatchesApi(
      jsonRequest(`/api/matches/${matchId}/cancel`, 'POST', {}),
      testEnv,
    )

    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({ match: { id: matchId, status: 'cancelled' } })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('quotes and creates one waiting party for repeated idempotency keys', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({
      id: hostId,
      email: 'host@example.com',
      sessionId: 'host-secret-session',
      userId: 101,
      grooopies: 1_000,
    })
    await seedAccount({
      id: guestId,
      email: 'guest@example.com',
      sessionId: 'guest-secret-session',
      userId: 202,
      grooopies: 500,
    })

    const outbound: Array<{ path: string; bearer: string | null; body: unknown }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://server.grooop.io')
      const headers = new Headers(init?.headers)
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
      const bearer = headers.get('bearer')
      outbound.push({ path: url.pathname, bearer, body })

      if (url.pathname === '/api/1.0/party/parameters') {
        expect(bearer).toBe('host-secret-session')
        return Response.json({ parameters: { grooop: { duration: [15, 60, 15, 15] } } })
      }
      if (url.pathname === '/api/1.0/user/retrieve') {
        if (bearer === 'host-secret-session') {
          return Response.json({ user: { id: 101, grooopies: 1_000 } })
        }
        if (bearer === 'guest-secret-session') {
          return Response.json({ user: { id: 202, grooopies: 500 } })
        }
      }
      if (url.pathname === '/api/1.0/party/compute-cost') {
        expect(bearer).toBe('host-secret-session')
        expect(body).toEqual({ gameMode: 'grooop', totalPlayers: 2, duration: 15, rounds: null, isOnline: false })
        return Response.json({ cost: 40, userCanSpend: true })
      }
      if (url.pathname === '/api/1.0/party/create') {
        expect(bearer).toBe('host-secret-session')
        return Response.json({
          status: 'success',
          party: { id: 555, code: 'ABC123', cost: 40 },
          balance: { grooopies: 960 },
        })
      }
      if (url.pathname === '/api/1.0/party/ABC123/query') {
        expect(bearer).toBe('guest-secret-session')
        return Response.json({ status: 'success', party: { id: 555, title: 'Reds vs Blues' } })
      }
      if (url.pathname === '/api/1.0/party/ABC123/join') {
        expect(bearer).toBe('guest-secret-session')
        return Response.json({ status: 'success' })
      }
      throw new Error(`Unexpected Grooop request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    let initializeAttempts = 0
    const initialize = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://match.internal/internal/initialize')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body)) as { matchId: string }
      expect(body.matchId).toMatch(/^[a-f0-9-]{36}$/)
      initializeAttempts += 1
      return new Response(null, { status: initializeAttempts === 1 ? 503 : 204 })
    })
    const fakeMatches = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: initialize })),
    } as unknown as DurableObjectNamespace
    const testEnv = { ...env, MATCHES: fakeMatches } as Env

    const input = {
      gameMode: 'proximo',
      hostAccountId: hostId,
      teamAAccountId: hostId,
      teamBAccountId: guestId,
      teamA: { name: 'Reds', roster: ['Alice'] },
      teamB: { name: 'Blues', roster: ['Bob'] },
      contentSlug: '300',
      durationMinutes: 15,
    }
    const quoteResponse = await handleMatchesApi(
      jsonRequest('/api/matches/quote', 'POST', input),
      testEnv,
    )
    expect(await quoteResponse!.json()).toEqual({
      quote: {
        cost: 40,
        userCanSpend: true,
        hostBalance: 1_000,
        guestBalance: 500,
      },
    })

    const upperKey = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const firstResponse = await handleMatchesApi(
      jsonRequest('/api/matches', 'POST', { ...input, expectedCost: 40, idempotencyKey: upperKey }),
      testEnv,
    )
    expect(firstResponse?.status).toBe(201)
    const firstPayload = await firstResponse!.json() as { match: Record<string, unknown> }
    expect(firstPayload.match).toMatchObject({
      status: 'waiting', cost: 40, gameMode: 'proximo', contentSlug: '300', durationMinutes: 15, rounds: null,
    })
    expect(firstPayload.match).not.toHaveProperty('hostAccountId')
    expect(firstPayload.match).not.toHaveProperty('guestAccountId')
    expect(firstPayload.match).not.toHaveProperty('partyId')
    expect(firstPayload.match).not.toHaveProperty('gameId')
    expect(firstPayload.match).not.toHaveProperty('updatedAt')
    const publicBody = JSON.stringify(firstPayload)
    expect(publicBody).not.toContain('ABC123')
    expect(publicBody).not.toContain('host-secret-session')
    expect(publicBody).not.toContain('guest-secret-session')

    const secondResponse = await handleMatchesApi(
      jsonRequest('/api/matches', 'POST', {
        ...input,
        expectedCost: 40,
        idempotencyKey: upperKey.toLowerCase(),
      }),
      testEnv,
    )
    expect(secondResponse?.status).toBe(200)
    expect(await secondResponse!.json()).toEqual(firstPayload)

    await expect(handleMatchesApi(
      jsonRequest('/api/matches', 'POST', {
        ...input,
        expectedCost: 41,
        idempotencyKey: upperKey.toLowerCase(),
      }),
      testEnv,
    )).rejects.toMatchObject({ status: 409, code: 'idempotency-conflict' })

    const paths = outbound.map((request) => request.path)
    expect(paths.filter((path) => path === '/api/1.0/party/create')).toHaveLength(1)
    expect(paths.filter((path) => path === '/api/1.0/party/ABC123/query')).toHaveLength(1)
    expect(paths.filter((path) => path === '/api/1.0/party/ABC123/join')).toHaveLength(1)
    expect(initialize).toHaveBeenCalledTimes(2)

    const persisted = await env.DB.prepare(
       `SELECT idempotency_key, request_fingerprint, status, party_id, party_code_ciphertext, cost, game_mode, rounds
       FROM matches`,
    ).first<{
      idempotency_key: string
      request_fingerprint: string
      status: string
      party_id: number
      party_code_ciphertext: string
      cost: number
      game_mode: string
      rounds: number | null
    }>()
    expect(persisted).toMatchObject({
      idempotency_key: upperKey.toLowerCase(),
      status: 'waiting',
      party_id: 555,
      cost: 40,
      game_mode: 'proximo',
      rounds: null,
    })
    expect(persisted?.request_fingerprint).toBeTruthy()
    expect(persisted?.party_code_ciphertext).not.toBe('ABC123')
    expect(await env.DB.prepare('SELECT grooopies FROM accounts WHERE id = ?')
      .bind(hostId).first()).toEqual({ grooopies: 960 })
  })

  it('quotes, creates, and persists TTMC matches with mode-specific settings', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host-session', userId: 101, grooopies: 1_000 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest-session', userId: 202, grooopies: 500 })
    const outbound: Array<{ path: string; body: unknown }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
      outbound.push({ path, body })
      if (path === '/api/1.0/party/parameters') {
        return Response.json({ gameModes: [{ name: 'ttmc', isBought: true }], parameters: { ttmc: {
          rounds: [2, 10, 5, 1],
          contents: [
            { slug: 'included', title: 'Standard', available: true },
            { slug: 'sports', title: 'Sports', available: true },
            { slug: 'disabled', title: 'Disabled', available: false },
          ],
        } } })
      }
      if (path === '/api/1.0/user/retrieve') {
        return Response.json({ user: new Headers(init?.headers).get('bearer') === 'host-session'
          ? { id: 101, grooopies: 1_000 } : { id: 202, grooopies: 500 } })
      }
      if (path === '/api/1.0/party/compute-cost') {
        expect(body).toEqual({ gameMode: 'ttmc', totalPlayers: 2, duration: null, rounds: 5, isOnline: false })
        return Response.json({ cost: 30, userCanSpend: true })
      }
      if (path === '/api/1.0/party/create') {
        expect(body).toEqual({
          gameMode: 'ttmc', totalPlayers: 2, title: 'Reds vs Blues', thumbnail: 'welcome/background-1',
          currency: 'welcome/currency-1', isOnline: false, isIRL: true, rounds: 5, selectedContents: ['included', 'sports'],
        })
        return Response.json({ status: 'success', party: { id: 556, code: 'DEF456', cost: 30 } })
      }
      if (path === '/api/1.0/party/DEF456/query') return Response.json({ status: 'success', party: { id: 556 } })
      if (path === '/api/1.0/party/DEF456/join') return Response.json({ status: 'success' })
      throw new Error(`Unexpected Grooop request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const testEnv = {
      ...env,
      MATCHES: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      } as unknown as DurableObjectNamespace,
    } as Env
    const input = {
      gameMode: 'ttmc', hostAccountId: hostId, teamAAccountId: hostId, teamBAccountId: guestId,
      teamA: { name: 'Reds', roster: ['Alice'] }, teamB: { name: 'Blues', roster: ['Bob'] }, rounds: 5,
      ttmcContentSlugs: ['sports', 'included', 'sports'],
    }

    const quote = await handleMatchesApi(jsonRequest('/api/matches/quote', 'POST', input), testEnv)
    expect(await quote!.json()).toMatchObject({ quote: { cost: 30 } })
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const created = await handleMatchesApi(jsonRequest('/api/matches', 'POST', {
      ...input, expectedCost: 30, idempotencyKey: key,
    }), testEnv)
    expect(created?.status).toBe(201)
    expect(await created!.json()).toMatchObject({ match: {
      status: 'waiting', gameMode: 'ttmc', contentSlug: null, durationMinutes: null, rounds: 5,
      ttmcContentSlugs: ['included', 'sports'],
    } })
    await expect(handleMatchesApi(jsonRequest('/api/matches', 'POST', {
       ...input, ttmcContentSlugs: ['included'], expectedCost: 30, idempotencyKey: key,
    }), testEnv)).rejects.toMatchObject({ status: 409, code: 'idempotency-conflict' })
    expect(await env.DB.prepare('SELECT game_mode, content_slug, duration_minutes, rounds, ttmc_contents_json FROM matches').first())
      .toEqual({ game_mode: 'ttmc', content_slug: null, duration_minutes: null, rounds: 5, ttmc_contents_json: '["included","sports"]' })
    expect(outbound.filter((request) => request.path === '/api/1.0/party/create')).toHaveLength(1)
  })

  it('rejects unavailable, malformed, and oversized live TTMC content parameters before quoting', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    let contents: unknown = [{ slug: 'included', title: 'Standard', available: false }]
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/1.0/party/parameters') return Response.json({ gameModes: [{ name: 'ttmc', isBought: true }], parameters: { ttmc: { rounds: [2, 10, 5, 1], contents } } })
      throw new Error(`Unexpected Grooop request: ${path}`)
    })
    const input = {
      gameMode: 'ttmc', hostAccountId: hostId, teamAAccountId: hostId, teamBAccountId: guestId,
      teamA: { name: 'Reds', roster: ['Alice'] }, teamB: { name: 'Blues', roster: ['Bob'] },
      rounds: 5, ttmcContentSlugs: ['included'],
    }
    await expect(handleMatchesApi(jsonRequest('/api/matches/quote', 'POST', input), env))
      .rejects.toMatchObject({ status: 400, code: 'ttmc-content-unavailable' })
    contents = [{ slug: 'included', title: 'Standard', available: 'yes' }]
    await expect(handleMatchesApi(jsonRequest('/api/matches/quote', 'POST', input), env))
      .rejects.toMatchObject({ status: 502, code: 'invalid-ttmc-contents' })
    contents = Array.from({ length: 33 }, (_, index) => ({
      slug: `content-${index}`, title: `Content ${index}`, available: true,
    }))
    await expect(handleMatchesApi(jsonRequest('/api/matches/quote', 'POST', input), env))
      .rejects.toMatchObject({ status: 502, code: 'invalid-ttmc-contents' })
  })

  it.each([
    ['ownership', 'game-mode-not-bought'],
    ['content availability', 'ttmc-content-unavailable'],
  ])('revalidates TTMC %s before a paid create', async (change, code) => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    let owned = true
    let available = true
    const paths: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/api/1.0/party/parameters') return Response.json({
        gameModes: [{ name: 'ttmc', isBought: owned }],
        parameters: { ttmc: { rounds: [2, 10, 5, 1], contents: [{ slug: 'included', title: 'Standard', available }] } },
      })
      if (path === '/api/1.0/user/retrieve') return Response.json({
        user: new Headers(init?.headers).get('bearer') === 'host'
          ? { id: 101, grooopies: 1_000 }
          : { id: 202, grooopies: 500 },
      })
      if (path === '/api/1.0/party/compute-cost') return Response.json({ cost: 30, userCanSpend: true })
      throw new Error(`Unexpected Grooop request: ${path}`)
    })
    const input = {
      gameMode: 'ttmc', hostAccountId: hostId, teamAAccountId: hostId, teamBAccountId: guestId,
      teamA: { name: 'Reds', roster: ['Alice'] }, teamB: { name: 'Blues', roster: ['Bob'] },
      rounds: 5, ttmcContentSlugs: ['included'],
    }
    await expect(handleMatchesApi(jsonRequest('/api/matches/quote', 'POST', input), env)).resolves.toBeTruthy()
    if (change === 'ownership') owned = false
    else available = false
    await expect(handleMatchesApi(jsonRequest('/api/matches', 'POST', {
      ...input, expectedCost: 30, idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }), env)).rejects.toMatchObject({ code })
    expect(paths).not.toContain('/api/1.0/party/create')
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM matches').first()).toEqual({ count: 0 })
  })

  it('resumes a persisted joining match without repeating party creation', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({
      id: hostId,
      email: 'host@example.com',
      sessionId: 'host-session',
      userId: 101,
    })
    await seedAccount({
      id: guestId,
      email: 'guest@example.com',
      sessionId: 'guest-session',
      userId: 202,
    })

    let queryAttempts = 0
    const paths: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const bearer = new Headers(init?.headers).get('bearer')
      paths.push(path)
      if (path === '/api/1.0/party/parameters') return Response.json({ parameters: { grooop: { duration: [15, 60, 15, 15] } } })
      if (path === '/api/1.0/user/retrieve') {
        return Response.json({
          user: bearer === 'host-session'
            ? { id: 101, grooopies: 1_000 }
            : { id: 202, grooopies: 500 },
        })
      }
      if (path === '/api/1.0/party/compute-cost') {
        return Response.json({ cost: 40, userCanSpend: true })
      }
      if (path === '/api/1.0/party/create') {
        return Response.json({
          status: 'success',
          party: { id: 555, code: 'ABC123', cost: 40 },
          balance: { grooopies: 960 },
        })
      }
      if (path === '/api/1.0/party/ABC123/query') {
        queryAttempts += 1
        if (queryAttempts === 1) return Response.json({ status: 'party-not-ready' })
        return Response.json({ status: 'success', party: { id: 555 } })
      }
      if (path === '/api/1.0/party/ABC123/join') return Response.json({ status: 'success' })
      throw new Error(`Unexpected Grooop request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const initialize = vi.fn(async () => new Response(null, { status: 204 }))
    const testEnv = {
      ...env,
      MATCHES: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: initialize }),
      } as unknown as DurableObjectNamespace,
    } as Env
    const input = {
      gameMode: 'proximo',
      hostAccountId: hostId,
      teamAAccountId: hostId,
      teamBAccountId: guestId,
      teamA: { name: 'Reds', roster: ['Alice'] },
      teamB: { name: 'Blues', roster: ['Bob'] },
      contentSlug: '300',
      durationMinutes: 15,
      expectedCost: 40,
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }

    await expect(handleMatchesApi(jsonRequest('/api/matches', 'POST', input), testEnv))
      .rejects.toMatchObject({ status: 502, code: 'party-not-ready' })
    expect(await env.DB.prepare('SELECT status, error_code FROM matches').first()).toEqual({
      status: 'joining',
      error_code: 'party-not-ready',
    })

    const persisted = await env.DB.prepare('SELECT id FROM matches').first<{ id: string }>()
    const resumed = await handleMatchesApi(
      jsonRequest(`/api/matches/${persisted!.id}/resume`, 'POST'),
      testEnv,
    )
    expect(resumed?.status).toBe(200)
    expect(await resumed!.json()).toMatchObject({ match: { status: 'waiting' } })
    expect(paths.filter((path) => path === '/api/1.0/party/create')).toHaveLength(1)
    expect(paths.filter((path) => path === '/api/1.0/party/ABC123/query')).toHaveLength(2)
    expect(paths.filter((path) => path === '/api/1.0/party/ABC123/join')).toHaveLength(1)
    expect(initialize).toHaveBeenCalledOnce()
  })

  it('allows only one party creation for concurrent distinct keys', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({
      id: hostId,
      email: 'host@example.com',
      sessionId: 'host-session',
      userId: 101,
    })
    await seedAccount({
      id: guestId,
      email: 'guest@example.com',
      sessionId: 'guest-session',
      userId: 202,
    })

    const paths: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const bearer = new Headers(init?.headers).get('bearer')
      paths.push(path)
      if (path === '/api/1.0/party/parameters') return Response.json({ parameters: { grooop: { duration: [15, 60, 15, 15] } } })
      if (path === '/api/1.0/user/retrieve') {
        return Response.json({
          user: bearer === 'host-session'
            ? { id: 101, grooopies: 1_000 }
            : { id: 202, grooopies: 500 },
        })
      }
      if (path === '/api/1.0/party/compute-cost') {
        return Response.json({ cost: 40, userCanSpend: true })
      }
      if (path === '/api/1.0/party/create') {
        return Response.json({
          status: 'success',
          party: { id: 555, code: 'ABC123', cost: 40 },
        })
      }
      if (path === '/api/1.0/party/ABC123/query') {
        return Response.json({ status: 'success', party: { id: 555 } })
      }
      if (path === '/api/1.0/party/ABC123/join') return Response.json({ status: 'success' })
      throw new Error(`Unexpected Grooop request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const testEnv = {
      ...env,
      MATCHES: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      } as unknown as DurableObjectNamespace,
    } as Env
    const input = {
      gameMode: 'proximo',
      hostAccountId: hostId,
      teamAAccountId: hostId,
      teamBAccountId: guestId,
      teamA: { name: 'Reds', roster: ['Alice'] },
      teamB: { name: 'Blues', roster: ['Bob'] },
      contentSlug: '300',
      durationMinutes: 15,
      expectedCost: 40,
    }

    const results = await Promise.allSettled([
      handleMatchesApi(jsonRequest('/api/matches', 'POST', {
        ...input,
        idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }), testEnv),
      handleMatchesApi(jsonRequest('/api/matches', 'POST', {
        ...input,
        idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }), testEnv),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ status: 409, code: 'active-match-exists' })
    expect(paths.filter((path) => path === '/api/1.0/party/create')).toHaveLength(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM matches').first()).toEqual({ count: 1 })
  })

  it('blocks retries after an outcome-ambiguous party creation failure', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    const paths: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const bearer = new Headers(init?.headers).get('bearer')
      paths.push(path)
      if (path === '/api/1.0/party/parameters') return Response.json({ parameters: { grooop: { duration: [15, 60, 15, 15] } } })
      if (path === '/api/1.0/user/retrieve') {
        return Response.json({
          user: bearer === 'host'
            ? { id: 101, grooopies: 1_000 }
            : { id: 202, grooopies: 500 },
        })
      }
      if (path === '/api/1.0/party/compute-cost') {
        return Response.json({ cost: 40, userCanSpend: true })
      }
      if (path === '/api/1.0/party/create') throw new TypeError('connection reset')
      throw new Error(`Unexpected Grooop request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const testEnv = {
      ...env,
      MATCHES: {} as DurableObjectNamespace,
    } as Env
    const input = {
      gameMode: 'proximo',
      hostAccountId: hostId,
      teamAAccountId: hostId,
      teamBAccountId: guestId,
      teamA: { name: 'Reds', roster: ['Alice'] },
      teamB: { name: 'Blues', roster: ['Bob'] },
      contentSlug: '300',
      durationMinutes: 15,
      expectedCost: 40,
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }

    await expect(handleMatchesApi(jsonRequest('/api/matches', 'POST', input), testEnv))
      .rejects.toMatchObject({ status: 409, code: 'match-creation-unresolved' })
    expect(await env.DB.prepare('SELECT status, error_code FROM matches').first()).toEqual({
      status: 'error',
      error_code: 'party-create-outcome-unknown',
    })
    await expect(handleMatchesApi(jsonRequest('/api/matches', 'POST', input), testEnv))
      .rejects.toMatchObject({ status: 409, code: 'match-creation-unresolved' })
    await expect(handleMatchesApi(jsonRequest('/api/matches', 'POST', {
      ...input,
      idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }), testEnv)).rejects.toMatchObject({ status: 409, code: 'active-match-exists' })
    expect(paths.filter((path) => path === '/api/1.0/party/create')).toHaveLength(1)
  })

  it('rejects a legacy idempotency key without a request fingerprint', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    const idempotencyKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    await env.DB.prepare(
       `INSERT INTO matches (
         id, idempotency_key, status, host_account_id, guest_account_id, team_a_json,
         team_b_json, game_mode, content_slug, duration_minutes, cost, created_at, updated_at
       ) VALUES (?, ?, 'finished', ?, ?, ?, ?, 'proximo', '300', 15, 40, ?, ?)`,
    ).bind(
      '33333333-3333-4333-8333-333333333333',
      idempotencyKey,
      hostId,
      guestId,
      JSON.stringify({ name: 'Reds', roster: ['Alice'], accountId: hostId }),
      JSON.stringify({ name: 'Blues', roster: ['Bob'], accountId: guestId }),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ).run()

    await expect(handleMatchesApi(jsonRequest('/api/matches', 'POST', {
      gameMode: 'proximo',
      hostAccountId: hostId,
      teamAAccountId: hostId,
      teamBAccountId: guestId,
      teamA: { name: 'Reds', roster: ['Alice'] },
      teamB: { name: 'Blues', roster: ['Bob'] },
      contentSlug: '300',
      durationMinutes: 15,
      expectedCost: 40,
      idempotencyKey,
    }), { ...env, MATCHES: {} as DurableObjectNamespace } as Env))
      .rejects.toMatchObject({ status: 409, code: 'idempotency-conflict' })
  })

  it('fails closed when persisted TTMC packs are not canonical', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    await env.DB.prepare(`INSERT INTO matches (
      id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
      game_mode, rounds, ttmc_contents_json, cost, created_at, updated_at
    ) VALUES (?, 'finished', ?, ?, ?, ?, 'ttmc', 5, '["included","included"]', 40, ?, ?)`).bind(
      '33333333-3333-4333-8333-333333333333', hostId, guestId,
      JSON.stringify({ name: 'Reds', roster: ['Alice'], accountId: hostId }),
      JSON.stringify({ name: 'Blues', roster: ['Bob'], accountId: guestId }),
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    ).run()
    await expect(handleMatchesApi(new Request('https://party.example/api/matches'), env))
      .rejects.toMatchObject({ status: 500, code: 'match-data-invalid' })
  })
})
