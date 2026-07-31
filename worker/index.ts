import { authorizeRequest } from './access'
import { handleAccountsApi } from './accounts'
import { claimDailyAds } from './ads'
import { encryptionIsConfigured } from './crypto'
import type { Env } from './env'
import { errorResponse, json } from './http'
import { handleLibraryApi } from './library'
import { MatchRoom } from './match-room'
import { handleMatchesApi } from './matches'
import { handleShopApi } from './shop'
import { assertSameOrigin } from './validation'

export { MatchRoom }

function productionIsConfigured(env: Env): boolean {
  return Boolean(
    encryptionIsConfigured(env) &&
      env.ACCESS_TEAM_DOMAIN &&
      !env.ACCESS_TEAM_DOMAIN.startsWith('replace-me.') &&
      env.ACCESS_AUD &&
      env.ACCESS_AUD !== 'replace-me' &&
      env.OWNER_EMAIL?.trim(),
  )
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/api/health') {
    await env.DB.prepare('SELECT request_fingerprint, game_mode, rounds, ttmc_contents_json FROM matches LIMIT 0').all()
    await env.DB.prepare('SELECT idempotency_key, request_fingerprint, status FROM shop_purchases LIMIT 0').all()
    return json({ status: 'ok', environment: env.ENVIRONMENT })
  }

  const accountsResponse = await handleAccountsApi(request, env)
  if (accountsResponse) return accountsResponse

  const libraryResponse = await handleLibraryApi(request, env)
  if (libraryResponse) return libraryResponse

  const matchesResponse = await handleMatchesApi(request, env)
  if (matchesResponse) return matchesResponse

  const shopResponse = await handleShopApi(request, env)
  if (shopResponse) return shopResponse

  const matchSocket = url.pathname.match(/^\/api\/matches\/([a-f0-9-]+)\/socket$/)
  if (matchSocket) {
    assertSameOrigin(request)
    const id = env.MATCHES.idFromName(matchSocket[1])
    const room = env.MATCHES.get(id)
    const initialized = await room.fetch('https://match.internal/internal/initialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId: matchSocket[1] }),
    })
    if (!initialized.ok) return initialized
    return room.fetch(request)
  }

  return json({ error: 'not-found', message: 'API route not found' }, { status: 404 })
}

export function secureStaticResponse(response: Response): Response {
  const secured = new Response(response.body, response)
  secured.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  )
  secured.headers.set('X-Frame-Options', 'DENY')
  secured.headers.set('X-Content-Type-Options', 'nosniff')
  secured.headers.set('Referrer-Policy', 'no-referrer')
  secured.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  return secured
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      if (env.ENVIRONMENT === 'production' && !productionIsConfigured(env)) {
        console.error('Production secrets or Cloudflare Access settings are incomplete')
        return json(
          { error: 'deployment-not-configured', message: 'Service configuration is incomplete' },
          { status: 503 },
        )
      }

      await authorizeRequest(request, env)
      const url = new URL(request.url)
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env)
      }
      return secureStaticResponse(await env.ASSETS.fetch(request))
    } catch (error) {
      return errorResponse(error)
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(claimDailyAds(env))
  },
} satisfies ExportedHandler<Env>
