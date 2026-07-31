import { afterEach, describe, expect, it, vi } from 'vitest'
import { retrieveUser } from '../../worker/grooop'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Grooop user validation', () => {
  it('returns a persisted user and sends account-scoped authentication', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('bearer')).toBe('secret-session')
      expect(headers.get('cookie')).toBe('grooop=secret-session')
      expect(headers.get('user-agent')).toBe('curl/8.21.0')
      return Response.json({ user: { id: 34869, grooopies: 1500 } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(retrieveUser('secret-session')).resolves.toMatchObject({
      id: 34869,
      grooopies: 1500,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects the successful-login-but-null-user state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user: null })))
    await expect(retrieveUser('unpersisted-session')).rejects.toMatchObject({
      code: 'grooop-user-missing',
    })
  })

  it.each([-1, 1.5])('rejects invalid Grooopies balance %s', async (grooopies) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user: { id: 34869, grooopies } })))
    await expect(retrieveUser('invalid-balance-session')).rejects.toMatchObject({
      code: 'grooop-user-invalid',
    })
  })

  it('marks a forbidden session as unauthorized without exposing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 'unauthorized' }, { status: 403 })),
    )
    await expect(retrieveUser('rejected-session')).rejects.toMatchObject({
      status: 401,
      code: 'grooop-unauthorized',
    })
  })
})
