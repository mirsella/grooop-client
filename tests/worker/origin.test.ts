import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { handleAccountsApi } from '../../worker/accounts'
import worker from '../../worker/index'
import { handleLibraryApi } from '../../worker/library'
import { handleMatchesApi } from '../../worker/matches'
import { jsonRequest } from './helpers'

describe('same-origin mutation guard', () => {
  it.each([
    ['account challenge', () => handleAccountsApi(
      jsonRequest('/api/accounts/challenges', 'POST', { email: 'owner@example.com' }, 'https://evil.test'),
      env,
    )],
    ['team preset', () => handleLibraryApi(
      jsonRequest('/api/team-presets', 'POST', { name: 'Reds', roster: ['Alice'] }, 'https://evil.test'),
      env,
    )],
    ['match quote', () => handleMatchesApi(
      jsonRequest('/api/matches/quote', 'POST', {}, 'https://evil.test'),
      env,
    )],
  ])('rejects a cross-origin %s before side effects', async (_name, invoke) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(invoke()).rejects.toMatchObject({ status: 403, code: 'invalid-origin' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM login_challenges').first())
      .toEqual({ count: 0 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM team_presets').first())
      .toEqual({ count: 0 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM matches').first())
      .toEqual({ count: 0 })
    vi.unstubAllGlobals()
  })

  it('rejects a cross-origin match WebSocket upgrade', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/api/matches/00000000-0000-4000-8000-000000000000/socket', {
        headers: {
          Origin: 'https://evil.test',
          Upgrade: 'websocket',
          'X-Dev-Access-Email': 'owner@example.com',
        },
      }),
      {
        ...env,
        ENVIRONMENT: 'development',
        OWNER_EMAIL: 'owner@example.com',
      },
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid-origin' })
  })

  it('initializes a same-origin room before proxying its WebSocket request', async () => {
    const calls: string[] = []
    const room = {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        calls.push(input instanceof Request ? input.url : String(input))
        return new Response(null, { status: 204 })
      }),
    }
    const matchId = '00000000-0000-4000-8000-000000000000'
    const response = await worker.fetch(
      new Request(`http://localhost/api/matches/${matchId}/socket`, {
        headers: {
          Origin: 'http://localhost',
          Upgrade: 'websocket',
          'X-Dev-Access-Email': 'owner@example.com',
        },
      }),
      {
        ...env,
        ENVIRONMENT: 'development',
        OWNER_EMAIL: 'owner@example.com',
        MATCHES: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => room),
        } as unknown as DurableObjectNamespace,
      },
    )

    expect(response.status).toBe(204)
    expect(calls).toEqual([
      'https://match.internal/internal/initialize',
      `http://localhost/api/matches/${matchId}/socket`,
    ])
  })

  it('adds anti-clickjacking and content security headers to static assets', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/', {
        headers: { 'X-Dev-Access-Email': 'owner@example.com' },
      }),
      {
        ...env,
        ENVIRONMENT: 'development',
        OWNER_EMAIL: 'owner@example.com',
        ASSETS: {
          fetch: vi.fn(async () => new Response('<html></html>', {
            headers: { 'Content-Type': 'text/html' },
          })),
        } as Fetcher,
      },
    )

    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('permissions-policy')).toContain('camera=()')
  })
})
