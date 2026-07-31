import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizeRequest } from '../../worker/access'
import type { Env } from '../../worker/env'

const owner = 'owner@example.com'

function accessEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'production',
    ACCESS_TEAM_DOMAIN: 'access-test.example.com',
    ACCESS_AUD: 'test-audience',
    OWNER_EMAIL: owner,
    ...overrides,
  } as Env
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Cloudflare Access authorization', () => {
  it('allows the exact owner in local development only', async () => {
    const env = accessEnv({ ENVIRONMENT: 'development' })
    await expect(authorizeRequest(new Request('http://localhost/api/health', {
      headers: { 'X-Dev-Access-Email': owner },
    }), env)).resolves.toEqual({ email: owner, subject: 'local-development' })

    await expect(authorizeRequest(new Request('https://app.example/api/health', {
      headers: { 'X-Dev-Access-Email': owner },
    }), env)).rejects.toMatchObject({ status: 401, code: 'access-required' })
  })

  it('verifies signature, issuer, audience, subject, and exact owner email', async () => {
    const domain = `access-${crypto.randomUUID()}.example.com`
    const env = accessEnv({ ACCESS_TEAM_DOMAIN: domain })
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
    const publicJwk = await exportJWK(publicKey)
    Object.assign(publicJwk, { alg: 'RS256', kid: 'test-key', use: 'sig' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [publicJwk] })))

    const sign = (email: string, audience = env.ACCESS_AUD) => new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('owner-subject')
      .setIssuer(`https://${domain}`)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)

    const request = (token: string) => new Request('https://app.example/', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    })

    await expect(authorizeRequest(request(await sign(owner)), env)).resolves.toEqual({
      email: owner,
      subject: 'owner-subject',
    })
    await expect(authorizeRequest(request(await sign('intruder@example.com')), env))
      .rejects.toMatchObject({ status: 403, code: 'owner-required' })
    await expect(authorizeRequest(request(await sign(owner, 'wrong-audience')), env))
      .rejects.toMatchObject({ status: 401, code: 'invalid-access-assertion' })
  })
})
