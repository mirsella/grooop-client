import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleShopApi } from '../../worker/shop'
import { jsonRequest, ORIGIN, seedAccount } from './helpers'

const accountId = '11111111-1111-4111-8111-111111111111'
const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function catalog(musiqueBought = false) {
  return {
    gameModes: [
      { name: 'ttmc', title: 'TTMC', config: { price: 5000, state: 'enabled' }, isBought: true, secret: 'never-returned' },
    ],
    extensions: [
      { name: 'ttmc-musique', title: 'TTMC Musique', config: { price: 1000, state: 'enabled', extensionGameMode: 'ttmc' }, isBought: musiqueBought },
      { name: 'ttmc-bonnebouffe', title: 'TTMC Bonne Bouffe', config: { price: 1000, state: 'enabled', extensionGameMode: 'ttmc' }, isBought: false },
      { name: 'proximo-musique', title: 'Proximo Musique', config: { price: 1000, state: 'enabled', extensionGameMode: 'grooop' }, isBought: false },
    ],
  }
}

function mockGrooop(
  buy: () => unknown | Promise<unknown> = () => ({ status: 'success', balance: { grooopies: 0 } }),
  rounds: readonly [number, number, number, number] = [2, 10, 5, 1],
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const bearer = new Headers(init?.headers).get('bearer')
    if (bearer !== 'shop-secret') return Response.json({ error: 'unauthorized' }, { status: 403 })
    if (path === '/api/1.0/user/retrieve') return Response.json({ user: { id: 101, grooopies: 1000, email: 'secret@example.com' } })
    if (path === '/api/1.0/pages/grooopex/') return Response.json(catalog())
    if (path === '/api/1.0/party/parameters') return Response.json({
      gameModes: [{ name: 'ttmc', isBought: true }],
      parameters: { ttmc: {
        rounds,
        contents: [
          { slug: 'included', title: 'Standard', extension: 'included', available: true, answer: 'secret' },
          { slug: 'locked', title: 'Locked', extension: 'locked', available: false },
        ],
      } },
    })
    if (path === '/api/1.0/shop/buy/extension/ttmc-musique') {
      expect(init?.body).toBeUndefined()
      return Response.json(await buy())
    }
    throw new Error(`Unexpected request ${path}`)
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('shop', () => {
  it('returns only a sanitized live catalog', async () => {
    await seedAccount({ id: accountId, email: 'secret@example.com', sessionId: 'shop-secret', userId: 101 })
    vi.stubGlobal('fetch', mockGrooop())
    const response = await handleShopApi(new Request(`${ORIGIN}/api/accounts/${accountId}/shop`), env)
    const text = await response!.text()
    expect(JSON.parse(text)).toEqual({
      owned: true,
      rounds: { min: 2, max: 10, default: 5, step: 1 },
      contents: [{ slug: 'included', title: 'Standard' }],
    })
    expect(text).not.toContain('shop-secret')
    expect(text).not.toContain('secret@example.com')
  })

  it('returns dynamic TTMC round bounds from the live catalog', async () => {
    await seedAccount({ id: accountId, email: 'secret@example.com', sessionId: 'shop-secret', userId: 101 })
    vi.stubGlobal('fetch', mockGrooop(undefined, [3, 21, 15, 3]))

    const response = await handleShopApi(new Request(`${ORIGIN}/api/accounts/${accountId}/shop`), env)

    expect(await response!.json()).toMatchObject({
      rounds: { min: 3, max: 21, default: 15, step: 3 },
    })
  })

  it('purchases exactly once and returns an idempotent repeat', async () => {
    await seedAccount({ id: accountId, email: 'secret@example.com', sessionId: 'shop-secret', userId: 101 })
    const fetchMock = mockGrooop()
    vi.stubGlobal('fetch', fetchMock)
    const request = () => jsonRequest(`/api/accounts/${accountId}/shop/extensions/ttmc-musique`, 'POST', { expectedPrice: 1000, idempotencyKey: key })
    expect((await handleShopApi(request(), env))?.status).toBe(201)
    const repeat = await handleShopApi(request(), env)
    expect(await repeat!.json()).toEqual({ purchase: { product: 'ttmc-musique', status: 'purchased', balance: 0, idempotent: true } })
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname.includes('/shop/buy/'))).toHaveLength(1)
    expect(await env.DB.prepare('SELECT status FROM shop_purchases').first()).toEqual({ status: 'purchased' })
  })

  it('converges concurrent requests with the same idempotency key on one claim', async () => {
    await seedAccount({ id: accountId, email: 'secret@example.com', sessionId: 'shop-secret', userId: 101 })
    let releaseBuy!: () => void
    const buyStarted = new Promise<void>((resolve) => { releaseBuy = resolve })
    const fetchMock = mockGrooop(async () => {
      await buyStarted
      return { status: 'success', balance: { grooopies: 0 } }
    })
    vi.stubGlobal('fetch', fetchMock)
    const request = () => jsonRequest(`/api/accounts/${accountId}/shop/extensions/ttmc-musique`, 'POST', { expectedPrice: 1000, idempotencyKey: key })
    const first = handleShopApi(request(), env)
    const second = handleShopApi(request(), env)
    const settled = Promise.allSettled([first, second])
    await vi.waitFor(async () => {
      expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first()).toEqual({ count: 1 })
    })
    releaseBuy()
    const results = await settled
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
    expect(results.some((result) => result.status === 'rejected' && result.reason?.code !== 'purchase-conflict')).toBe(true)
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname.includes('/shop/buy/'))).toHaveLength(1)
  })

  it('does not retry an ambiguous outcome and leaves it unresolved when ownership cannot be confirmed', async () => {
    await seedAccount({ id: accountId, email: 'secret@example.com', sessionId: 'shop-secret', userId: 101 })
    let catalogCalls = 0
    const fetchMock = mockGrooop(() => ({ status: 'unexpected' }))
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/1.0/pages/grooopex/') catalogCalls += 1
      if (path === '/api/1.0/pages/grooopex/' && catalogCalls > 1) return Response.json(catalog(false))
      return mockGrooop(() => ({ status: 'unexpected' }))(input, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const request = () => jsonRequest(`/api/accounts/${accountId}/shop/extensions/ttmc-musique`, 'POST', { expectedPrice: 1000, idempotencyKey: key })
    await expect(handleShopApi(request(), env)).rejects.toMatchObject({ code: 'purchase-outcome-unknown' })
    await expect(handleShopApi(request(), env)).rejects.toMatchObject({ status: 409, code: 'purchase-unresolved' })
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname.includes('/shop/buy/'))).toHaveLength(1)
  })

  it('rejects invalid products and prices before an upstream purchase', async () => {
    await seedAccount({ id: accountId, email: 'secret@example.com', sessionId: 'shop-secret', userId: 101 })
    const fetchMock = mockGrooop()
    vi.stubGlobal('fetch', fetchMock)
    await expect(handleShopApi(jsonRequest(`/api/accounts/${accountId}/shop/extensions/nope`, 'POST', { expectedPrice: 1000, idempotencyKey: key }), env)).rejects.toMatchObject({ code: 'product-not-found' })
    await expect(handleShopApi(jsonRequest(`/api/accounts/${accountId}/shop/extensions/ttmc-musique`, 'POST', { expectedPrice: 999, idempotencyKey: key }), env)).rejects.toMatchObject({ code: 'invalid-expected-price' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records documented rejections without blocking a later key', async () => {
    await seedAccount({ id: accountId, email: 'secret@example.com', sessionId: 'shop-secret', userId: 101 })
    let attempts = 0
    vi.stubGlobal('fetch', mockGrooop(() => (++attempts === 1
      ? { status: 'insufficient-balance' }
      : { status: 'success', balance: { grooopies: 0 } })))
    await expect(handleShopApi(jsonRequest(`/api/accounts/${accountId}/shop/extensions/ttmc-musique`, 'POST', { expectedPrice: 1000, idempotencyKey: key }), env)).rejects.toMatchObject({ code: 'insufficient-balance' })
    expect((await handleShopApi(jsonRequest(`/api/accounts/${accountId}/shop/extensions/ttmc-musique`, 'POST', { expectedPrice: 1000, idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), env))?.status).toBe(201)
    expect(await env.DB.prepare("SELECT status FROM shop_purchases WHERE idempotency_key = ?").bind(key).first()).toEqual({ status: 'rejected' })
  })

  it('prevents a second active product claim and marks rejected sessions for reauthentication', async () => {
    await seedAccount({ id: accountId, email: 'secret@example.com', sessionId: 'shop-secret', userId: 101 })
    const now = '2026-01-01T00:00:00.000Z'
    await env.DB.prepare(`INSERT INTO shop_purchases
      (id, idempotency_key, request_fingerprint, account_id, product_slug, expected_price, status, created_at, updated_at)
      VALUES ('purchase', 'other-key', 'other-fingerprint', ?, 'ttmc-musique', 1000, 'pending', ?, ?)`).bind(accountId, now, now).run()
    const fetchMock = mockGrooop()
    vi.stubGlobal('fetch', fetchMock)
    await expect(handleShopApi(jsonRequest(`/api/accounts/${accountId}/shop/extensions/ttmc-musique`, 'POST', { expectedPrice: 1000, idempotencyKey: key }), env)).rejects.toMatchObject({ code: 'purchase-conflict' })
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname.includes('/shop/buy/'))).toHaveLength(0)

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 403 })))
    await expect(handleShopApi(jsonRequest(`/api/accounts/${accountId}/shop/extensions/ttmc-bonnebouffe`, 'POST', { expectedPrice: 1000, idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }), env)).rejects.toMatchObject({ code: 'grooop-unauthorized' })
    expect(await env.DB.prepare('SELECT status FROM accounts WHERE id = ?').bind(accountId).first()).toEqual({ status: 'reauth-required' })
  })
})
