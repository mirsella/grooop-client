import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AccessIdentity, Env } from './env'
import { HttpError } from './http'

const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function normalizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export async function authorizeRequest(
  request: Request,
  env: Env,
): Promise<AccessIdentity> {
  const url = new URL(request.url)
  const ownerEmail = env.OWNER_EMAIL.trim().toLowerCase()

  if (
    env.ENVIRONMENT === 'development' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    const developmentEmail = request.headers.get('x-dev-access-email')?.toLowerCase()
    if (developmentEmail === ownerEmail) {
      return { email: developmentEmail, subject: 'local-development' }
    }
  }

  const assertion = request.headers.get('cf-access-jwt-assertion')
  if (!assertion) {
    throw new HttpError(401, 'access-required', 'Cloudflare Access assertion is required')
  }

  const domain = normalizeDomain(env.ACCESS_TEAM_DOMAIN)
  if (!domain || !env.ACCESS_AUD || !ownerEmail) {
    console.error('Cloudflare Access environment is incomplete')
    throw new HttpError(500, 'access-misconfigured', 'Access validation is unavailable')
  }

  let jwks = jwksByDomain.get(domain)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`))
    jwksByDomain.set(domain, jwks)
  }

  try {
    const { payload } = await jwtVerify(assertion, jwks, {
      audience: env.ACCESS_AUD,
      issuer: `https://${domain}`,
    })
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
    if (!email || email !== ownerEmail || typeof payload.sub !== 'string') {
      throw new HttpError(403, 'owner-required', 'This identity is not authorized')
    }
    return { email, subject: payload.sub }
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.warn('Cloudflare Access assertion rejected')
    throw new HttpError(401, 'invalid-access-assertion', 'Cloudflare Access assertion is invalid')
  }
}
