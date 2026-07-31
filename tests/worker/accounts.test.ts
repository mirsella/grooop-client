import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleAccountsApi } from '../../worker/accounts'
import { jsonRequest, seedAccount } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('account integration', () => {
  it('runs challenge, verify, refresh, reauthentication, and removal against D1', async () => {
    let magicCreates = 0
    let balance = 120
    let rejectNextRetrieve = false
    const outbound: Array<{ path: string; method: string; bearer: string | null; body: unknown }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://server.grooop.io')
      const headers = new Headers(init?.headers)
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
      outbound.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        bearer: headers.get('bearer'),
        body,
      })

      if (url.pathname === '/api/1.0/login/magic/create') {
        magicCreates += 1
        expect(body).toEqual({ email: 'owner@example.com' })
        return Response.json({ status: 'success' })
      }
      if (url.pathname === '/api/1.0/login/magic/verify') {
        expect(body).toMatchObject({ email: 'owner@example.com' })
        return Response.json({
          status: 'success',
          sessionId: magicCreates === 1 ? 'session-one' : 'session-two',
        })
      }
      if (url.pathname === '/api/1.0/user/retrieve') {
        if (rejectNextRetrieve) {
          rejectNextRetrieve = false
          return Response.json({ status: 'session-expired' }, { status: 403 })
        }
        expect(headers.get('cookie')).toBe(`grooop=${headers.get('bearer')}`)
        return Response.json({ user: { id: 701, grooopies: balance } })
      }
      throw new Error(`Unexpected Grooop request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const challengeResponse = await handleAccountsApi(
      jsonRequest('/api/accounts/challenges', 'POST', { email: '  Owner@Example.com ' }),
      env,
    )
    expect(challengeResponse?.status).toBe(201)
    const challengePayload = await challengeResponse!.json() as {
      challenge: { id: string; email: string }
    }
    expect(challengePayload.challenge.email).toBe('ow***@example.com')
    expect(challengePayload.challenge).not.toHaveProperty('expiresAt')
    expect(JSON.stringify(challengePayload)).not.toContain('owner@example.com')

    const storedChallenge = await env.DB.prepare(
      'SELECT email_ciphertext, email_nonce, email_hash FROM login_challenges WHERE id = ?',
    ).bind(challengePayload.challenge.id).first<Record<string, string>>()
    expect(storedChallenge).not.toBeNull()
    expect(Object.values(storedChallenge!)).not.toContain('owner@example.com')

    const verifiedResponse = await handleAccountsApi(
      jsonRequest(`/api/accounts/challenges/${challengePayload.challenge.id}/verify`, 'POST', {
        code: 'ab12cd34',
      }),
      env,
    )
    const verifiedPayload = await verifiedResponse!.json() as {
      account: { id: string; email: string; userId: number; grooopies: number; status: string }
    }
    expect(verifiedPayload.account).toMatchObject({
      email: 'ow***@example.com',
      userId: 701,
      grooopies: 120,
      status: 'active',
    })
    expect(verifiedPayload.account).not.toHaveProperty('validatedAt')
    const publicVerification = JSON.stringify(verifiedPayload)
    expect(publicVerification).not.toContain('owner@example.com')
    expect(publicVerification).not.toContain('session-one')
    expect(publicVerification).not.toContain('ciphertext')
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM login_challenges').first())
      .toEqual({ count: 0 })

    const storedAccount = await env.DB.prepare(
      `SELECT email_ciphertext, email_nonce, session_ciphertext, session_nonce, email_masked
       FROM accounts WHERE id = ?`,
    ).bind(verifiedPayload.account.id).first<Record<string, string>>()
    expect(storedAccount?.email_masked).toBe('ow***@example.com')
    expect(Object.values(storedAccount!)).not.toContain('owner@example.com')
    expect(Object.values(storedAccount!)).not.toContain('session-one')

    balance = 175
    const refreshedResponse = await handleAccountsApi(
      jsonRequest(`/api/accounts/${verifiedPayload.account.id}/refresh`, 'POST', {}),
      env,
    )
    expect(await refreshedResponse!.json()).toMatchObject({
      account: { id: verifiedPayload.account.id, grooopies: 175, status: 'active' },
    })

    rejectNextRetrieve = true
    await expect(handleAccountsApi(
      jsonRequest(`/api/accounts/${verifiedPayload.account.id}/refresh`, 'POST', {}),
      env,
    )).rejects.toMatchObject({ status: 401, code: 'grooop-unauthorized' })
    expect(await env.DB.prepare('SELECT status FROM accounts WHERE id = ?')
      .bind(verifiedPayload.account.id).first()).toEqual({ status: 'reauth-required' })

    const reauthResponse = await handleAccountsApi(
      jsonRequest(`/api/accounts/${verifiedPayload.account.id}/reauthenticate`, 'POST', {}),
      env,
    )
    expect(reauthResponse?.status).toBe(201)
    const reauth = await reauthResponse!.json() as { challenge: { id: string; email: string } }
    expect(reauth.challenge.email).toBe('ow***@example.com')
    balance = 190
    const reverifiedResponse = await handleAccountsApi(
      jsonRequest(`/api/accounts/challenges/${reauth.challenge.id}/verify`, 'POST', {
        code: 'ef56gh78',
      }),
      env,
    )
    expect(await reverifiedResponse!.json()).toMatchObject({
      account: { id: verifiedPayload.account.id, grooopies: 190, status: 'active' },
    })

    const removedResponse = await handleAccountsApi(
      jsonRequest(`/api/accounts/${verifiedPayload.account.id}`, 'DELETE'),
      env,
    )
    expect(removedResponse?.status).toBe(204)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM accounts').first()).toEqual({ count: 0 })
    expect(magicCreates).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(8)
    expect(outbound.every((request) => request.path.startsWith('/api/1.0/'))).toBe(true)
  })

  it('rejects reauthentication when Grooop returns a different user identity', async () => {
    const accountId = '11111111-1111-4111-8111-111111111111'
    await seedAccount({
      id: accountId,
      email: 'owner@example.com',
      sessionId: 'expired-session',
      userId: 701,
      status: 'reauth-required',
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/1.0/login/magic/create') return Response.json({ status: 'success' })
      if (path === '/api/1.0/login/magic/verify') {
        return Response.json({ status: 'success', sessionId: 'different-user-session' })
      }
      if (path === '/api/1.0/user/retrieve') {
        return Response.json({ user: { id: 702, grooopies: 300 } })
      }
      throw new Error(`Unexpected Grooop request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const challengeResponse = await handleAccountsApi(
      jsonRequest(`/api/accounts/${accountId}/reauthenticate`, 'POST', {}),
      env,
    )
    const challenge = await challengeResponse!.json() as { challenge: { id: string } }
    await expect(handleAccountsApi(
      jsonRequest(`/api/accounts/challenges/${challenge.challenge.id}/verify`, 'POST', {
        code: 'ab12cd34',
      }),
      env,
    )).rejects.toMatchObject({ status: 409, code: 'account-identity-changed' })

    expect(await env.DB.prepare(
      'SELECT grooop_user_id, status FROM accounts WHERE id = ?',
    ).bind(accountId).first()).toEqual({ grooop_user_id: 701, status: 'reauth-required' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('atomically limits concurrent magic-code verification attempts', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/1.0/login/magic/create') return Response.json({ status: 'success' })
      if (path === '/api/1.0/login/magic/verify') return Response.json({ status: 'invalid-code' })
      throw new Error(`Unexpected Grooop request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const challengeResponse = await handleAccountsApi(
      jsonRequest('/api/accounts/challenges', 'POST', { email: 'owner@example.com' }),
      env,
    )
    const challenge = await challengeResponse!.json() as { challenge: { id: string } }
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => handleAccountsApi(
      jsonRequest(`/api/accounts/challenges/${challenge.challenge.id}/verify`, 'POST', {
        code: 'ab12cd34',
      }),
      env,
    )))

    const errors = attempts.map((attempt) => {
      expect(attempt.status).toBe('rejected')
      return (attempt as PromiseRejectedResult).reason as { status: number; code: string }
    })
    expect(errors.filter((error) => error.code === 'invalid-code')).toHaveLength(5)
    expect(errors.filter((error) => error.code === 'too-many-code-attempts')).toHaveLength(1)
    expect(await env.DB.prepare(
      'SELECT attempts FROM login_challenges WHERE id = ?',
    ).bind(challenge.challenge.id).first()).toEqual({ attempts: 5 })
    expect(fetchMock.mock.calls.filter(([input]) => (
      new URL(String(input)).pathname === '/api/1.0/login/magic/verify'
    ))).toHaveLength(5)
  })

  it.each(['finished', 'error'] as const)(
    'rejects removal when the account has %s match history',
    async (status) => {
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
      await env.DB.prepare(
        `INSERT INTO matches (
           id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
           game_mode, content_slug, duration_minutes, cost, error_code, created_at, updated_at
         ) VALUES (?, ?, ?, ?, '{}', '{}', 'proximo', '300', 15, 40, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        status,
        hostId,
        guestId,
        status === 'error' ? 'party-create-rejected' : null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      ).run()

      await expect(handleAccountsApi(
        jsonRequest(`/api/accounts/${hostId}`, 'DELETE'),
        env,
      )).rejects.toMatchObject({ status: 409, code: 'account-has-history' })
      expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM accounts').first())
        .toEqual({ count: 2 })
    },
  )

  it('keeps the active-match-specific account removal conflict', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    await env.DB.prepare(
      `INSERT INTO matches (
         id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
         game_mode, content_slug, duration_minutes, cost, created_at, updated_at
       ) VALUES (?, 'waiting', ?, ?, '{}', '{}', 'proximo', '300', 15, 40, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      hostId,
      guestId,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ).run()

    await expect(handleAccountsApi(
      jsonRequest(`/api/accounts/${hostId}`, 'DELETE'),
      env,
    )).rejects.toMatchObject({ status: 409, code: 'account-in-active-match' })
  })
})
