import { accountSecrets, withAccountSession } from './accounts'
import { sha256 } from './crypto'
import type { Env } from './env'
import { extractStatus, grooopRequest, retrieveUser } from './grooop'
import { HttpError, json, readJson } from './http'
import { parseTtmcParameters } from './party-parameters'
import { assertSameOrigin, requireIdempotencyKey, requireObject } from './validation'

const EXTENSIONS = new Map([
  ['ttmc-musique', { price: 1000 }],
  ['ttmc-bonnebouffe', { price: 1000 }],
])
const REJECTIONS = new Set(['product-not-found', 'insufficient-balance', 'game-mode-not-bought', 'game-not-bought'])

interface CatalogProduct { slug: string; title: string; price: number; state: string; isBought: boolean }
interface GrooopexCatalog { ttmcOwned: boolean; extensions: CatalogProduct[] }
interface PurchaseRow {
  id: string; idempotency_key: string; request_fingerprint: string; account_id: string
  product_slug: string; expected_price: number; status: 'pending' | 'purchased' | 'unknown' | 'rejected'
  error_code: string | null
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function catalogItem(value: unknown, expectedKind: 'game-mode' | 'extension'): CatalogProduct {
  const item = object(value)
  const config = object(item?.config)
  if (!item || typeof item.name !== 'string' || !item.name || typeof item.title !== 'string' ||
    !item.title || !config || !Number.isSafeInteger(config.price) || Number(config.price) < 0 ||
    typeof config.state !== 'string' || typeof item.isBought !== 'boolean' ||
    (expectedKind === 'extension' && config.extensionGameMode !== 'ttmc')) {
    console.error('Grooopex catalog has an invalid item', { expectedKind })
    throw new HttpError(502, 'invalid-grooopex-catalog', 'Grooopex returned an invalid catalog')
  }
  return {
    slug: item.name,
    title: item.title,
    price: Number(config.price),
    state: config.state,
    isBought: item.isBought,
  }
}

function catalogFromGrooopex(value: unknown): GrooopexCatalog {
  const root = object(value)
  if (!root || !Array.isArray(root.gameModes) || !Array.isArray(root.extensions)) {
    console.error('Grooopex catalog is missing product collections')
    throw new HttpError(502, 'invalid-grooopex-catalog', 'Grooopex returned an invalid catalog')
  }
  const modes = root.gameModes.map((item) => catalogItem(item, 'game-mode'))
  const extensions = root.extensions
    .filter((item) => object(object(item)?.config)?.extensionGameMode === 'ttmc')
    .map((item) => catalogItem(item, 'extension'))
  const duplicate = [...modes, ...extensions].find((item, index, items) =>
    items.findIndex((candidate) => candidate.slug === item.slug) !== index)
  const ttmcModes = modes.filter((mode) => mode.slug === 'ttmc')
  if (ttmcModes.length !== 1 || duplicate) {
    console.error('Grooopex catalog is missing TTMC mode')
    throw new HttpError(502, 'invalid-grooopex-catalog', 'Grooopex returned an invalid catalog')
  }
  return {
    ttmcOwned: ttmcModes[0].isBought,
    extensions,
  }
}

async function loadCatalog(sessionId: string): Promise<GrooopexCatalog> {
  return catalogFromGrooopex(await grooopRequest<unknown>('pages/grooopex/', { sessionId }))
}

function productForPurchase(catalog: GrooopexCatalog, slug: string): CatalogProduct {
  const product = catalog.extensions.find((item) => item.slug === slug)
  const expected = EXTENSIONS.get(slug)
  if (!product || !expected || product.price !== expected.price || product.state !== 'enabled') {
    throw new HttpError(422, 'product-not-found', 'The extension is not available for purchase')
  }
  if (product.isBought) throw new HttpError(409, 'product-already-bought', 'The extension is already owned')
  return product
}

async function verifiedUser(env: Env, accountId: string, sessionId: string, userId: number) {
  const user = await withAccountSession(env, accountId, () => retrieveUser(sessionId))
  if (user.id !== userId) {
    console.error('Grooop user identity or balance violated shop invariant', { accountId })
    throw new HttpError(409, 'account-identity-changed', 'Account identity changed')
  }
  return user
}

async function getShop(env: Env, accountId: string): Promise<Response> {
  const { sessionId } = await accountSecrets(env, accountId)
  const parameters = parseTtmcParameters(await withAccountSession(env, accountId, () =>
    grooopRequest<unknown>('party/parameters', { sessionId })))
  const [min, max, defaultRounds, step] = parameters.rounds
  return json({
    owned: parameters.owned,
    rounds: { min, max, default: defaultRounds, step },
    contents: parameters.contents,
  })
}

function purchaseInput(value: unknown): { expectedPrice: number; idempotencyKey: string } {
  const body = requireObject(value)
  if (!Number.isSafeInteger(body.expectedPrice) || Number(body.expectedPrice) < 0) {
    throw new HttpError(400, 'invalid-expected-price', 'expectedPrice must be a nonnegative integer')
  }
  return { expectedPrice: Number(body.expectedPrice), idempotencyKey: requireIdempotencyKey(body.idempotencyKey) }
}

async function updatePurchase(env: Env, id: string, status: PurchaseRow['status'], errorCode: string | null = null): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(`UPDATE shop_purchases SET status = ?, error_code = ?, updated_at = ?,
    purchased_at = CASE WHEN ? = 'purchased' THEN ? ELSE purchased_at END,
    rejected_at = CASE WHEN ? = 'rejected' THEN ? ELSE rejected_at END WHERE id = ?`)
    .bind(status, errorCode, now, status, now, status, now, id).run()
}

async function reconcile(env: Env, purchase: PurchaseRow, sessionId: string, userId: number): Promise<Response> {
  const [catalog, user] = await withAccountSession(env, purchase.account_id, async () => Promise.all([
    loadCatalog(sessionId), verifiedUser(env, purchase.account_id, sessionId, userId),
  ]))
  const owned = catalog.extensions.find((product) => product.slug === purchase.product_slug)?.isBought === true
  if (!owned) throw new HttpError(409, 'purchase-unresolved', 'The previous purchase outcome is unresolved')
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET grooopies = ?, validated_at = ?, updated_at = ? WHERE id = ?')
      .bind(user.grooopies, new Date().toISOString(), new Date().toISOString(), purchase.account_id),
    env.DB.prepare(`UPDATE shop_purchases SET status = 'purchased', error_code = NULL, updated_at = ?, purchased_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), new Date().toISOString(), purchase.id),
  ])
  return json({ purchase: { product: purchase.product_slug, status: 'purchased', balance: user.grooopies, idempotent: true } })
}

async function existingPurchaseResponse(
  env: Env,
  purchase: PurchaseRow,
  fingerprint: string,
  sessionId: string,
  userId: number,
  balance: number,
): Promise<Response> {
  if (purchase.request_fingerprint !== fingerprint) {
    throw new HttpError(409, 'idempotency-conflict', 'Idempotency key was used for a different purchase')
  }
  if (purchase.status === 'purchased') {
    return json({ purchase: { product: purchase.product_slug, status: 'purchased', balance, idempotent: true } })
  }
  if (purchase.status === 'rejected') {
    throw new HttpError(422, purchase.error_code ?? 'purchase-rejected', 'The purchase was rejected')
  }
  return reconcile(env, purchase, sessionId, userId)
}

async function purchaseExtension(request: Request, env: Env, accountId: string, slug: string): Promise<Response> {
  assertSameOrigin(request)
  if (!EXTENSIONS.has(slug)) throw new HttpError(404, 'product-not-found', 'Extension was not found')
  const input = purchaseInput(await readJson(request))
  const expected = EXTENSIONS.get(slug)!
  if (input.expectedPrice !== expected.price) throw new HttpError(422, 'invalid-expected-price', 'The expected price does not match')
  const fingerprint = await sha256(JSON.stringify({ accountId, slug, expectedPrice: input.expectedPrice }))
  const { account, sessionId } = await accountSecrets(env, accountId)
  const existing = await env.DB.prepare('SELECT * FROM shop_purchases WHERE idempotency_key = ?').bind(input.idempotencyKey).first<PurchaseRow>()
  if (existing) return existingPurchaseResponse(env, existing, fingerprint, sessionId, account.grooop_user_id, account.grooopies)

  const [catalog, user] = await withAccountSession(env, accountId, async () => Promise.all([
    loadCatalog(sessionId), verifiedUser(env, accountId, sessionId, account.grooop_user_id),
  ]))
  productForPurchase(catalog, slug)
  if (!catalog.ttmcOwned) throw new HttpError(422, 'game-mode-not-bought', 'TTMC must be owned first')
  if (user.grooopies < input.expectedPrice) throw new HttpError(422, 'insufficient-balance', 'Insufficient balance')

  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  try {
    await env.DB.prepare(`INSERT INTO shop_purchases
      (id, idempotency_key, request_fingerprint, account_id, product_slug, expected_price, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(id, input.idempotencyKey, fingerprint, accountId, slug, input.expectedPrice, now, now).run()
  } catch {
    const keyed = await env.DB.prepare('SELECT * FROM shop_purchases WHERE idempotency_key = ?')
      .bind(input.idempotencyKey).first<PurchaseRow>()
    if (keyed) return existingPurchaseResponse(env, keyed, fingerprint, sessionId, account.grooop_user_id, account.grooopies)
    const active = await env.DB.prepare(`SELECT id FROM shop_purchases
      WHERE account_id = ? AND product_slug = ? AND status IN ('pending', 'unknown', 'purchased')`)
      .bind(accountId, slug).first()
    if (active) throw new HttpError(409, 'purchase-conflict', 'An extension purchase is already in progress or completed')
    console.error('Shop purchase claim failed without an idempotency or active-product conflict', { accountId, slug })
    throw new HttpError(500, 'purchase-persistence-failed', 'The purchase was not saved')
  }
  try {
    const response = await withAccountSession(env, accountId, () => grooopRequest<unknown>(`shop/buy/extension/${slug}`, { method: 'POST', sessionId }))
    const status = extractStatus(response)
    if (status === 'success') {
      const balance = object(response)?.balance
      if (!object(balance) || !Number.isSafeInteger(object(balance)?.grooopies) || Number(object(balance)?.grooopies) < 0) {
        console.error('Shop success response has invalid balance', { accountId, slug })
        await updatePurchase(env, id, 'unknown', 'invalid-success-response')
        throw new HttpError(502, 'purchase-outcome-unknown', 'Purchase outcome could not be confirmed')
      }
      const grooopies = Number(object(balance)?.grooopies)
      await env.DB.batch([
        env.DB.prepare('UPDATE accounts SET grooopies = ?, validated_at = ?, updated_at = ? WHERE id = ?').bind(grooopies, now, now, accountId),
        env.DB.prepare(`UPDATE shop_purchases SET status = 'purchased', updated_at = ?, purchased_at = ? WHERE id = ?`).bind(now, now, id),
      ])
      return json({ purchase: { product: slug, status: 'purchased', balance: grooopies } }, { status: 201 })
    }
    if (REJECTIONS.has(status)) {
      await updatePurchase(env, id, 'rejected', status)
      throw new HttpError(422, status, 'The purchase was rejected')
    }
    if (status === 'product-already-bought') {
      await updatePurchase(env, id, 'unknown', 'product-already-bought')
      return reconcile(env, { id, idempotency_key: input.idempotencyKey, request_fingerprint: fingerprint, account_id: accountId, product_slug: slug, expected_price: input.expectedPrice, status: 'unknown', error_code: 'product-already-bought' }, sessionId, account.grooop_user_id)
    }
    console.error('Shop returned undocumented purchase outcome', { accountId, slug, status })
    await updatePurchase(env, id, 'unknown', 'undocumented-outcome')
    throw new HttpError(502, 'purchase-outcome-unknown', 'Purchase outcome could not be confirmed')
  } catch (error) {
    if (error instanceof HttpError && (REJECTIONS.has(error.code) || error.code === 'purchase-unresolved' || error.code === 'account-reauth-required')) throw error
    if (error instanceof HttpError && error.code === 'purchase-outcome-unknown') throw error
    await updatePurchase(env, id, 'unknown', error instanceof HttpError ? error.code : 'request-failed')
    throw new HttpError(502, 'purchase-outcome-unknown', 'Purchase outcome could not be confirmed')
  }
}

export async function handleShopApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  const shop = url.pathname.match(/^\/api\/accounts\/([a-f0-9-]+)\/shop$/)
  if (request.method === 'GET' && shop) return getShop(env, shop[1])
  const purchase = url.pathname.match(/^\/api\/accounts\/([a-f0-9-]+)\/shop\/extensions\/([a-z0-9-]+)$/)
  if (request.method === 'POST' && purchase) return purchaseExtension(request, env, purchase[1], purchase[2])
  return null
}
