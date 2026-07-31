import { decrypt, encrypt, lookupHash, maskEmail } from './crypto'
import type { Env } from './env'
import { extractStatus, grooopRequest, retrieveUser } from './grooop'
import { HttpError, json, readJson } from './http'
import {
  assertSameOrigin,
  requireEmail,
  requireMagicCode,
  requireObject,
} from './validation'

const CHALLENGE_TTL_MS = 15 * 60 * 1000
const CHALLENGE_COOLDOWN_MS = 60 * 1000
const MAX_CODE_ATTEMPTS = 5

interface AccountRow {
  id: string
  email_ciphertext: string
  email_nonce: string
  email_key_version: string
  email_hash: string
  email_masked: string
  session_ciphertext: string
  session_nonce: string
  session_key_version: string
  grooop_user_id: number
  grooopies: number
  status: 'active' | 'reauth-required'
  validated_at: string
  created_at: string
  updated_at: string
}

interface ChallengeRow {
  id: string
  email_ciphertext: string
  email_nonce: string
  email_key_version: string
  email_hash: string
  attempts: number
  expires_at: string
  created_at: string
}

function publicAccount(row: AccountRow): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email_masked,
    userId: row.grooop_user_id,
    grooopies: row.grooopies,
    status: row.status,
  }
}

async function accountById(env: Env, id: string): Promise<AccountRow> {
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
    .bind(id)
    .first<AccountRow>()
  if (!row) throw new HttpError(404, 'account-not-found', 'Account was not found')
  return row
}

export async function accountSecrets(
  env: Env,
  id: string,
): Promise<{ account: AccountRow; email: string; sessionId: string }> {
  const account = await accountById(env, id)
  if (account.status !== 'active') {
    throw new HttpError(409, 'account-reauth-required', 'Account must be re-authenticated')
  }
  const [email, sessionId] = await Promise.all([
    decrypt(
      {
        ciphertext: account.email_ciphertext,
        nonce: account.email_nonce,
        keyVersion: account.email_key_version,
      },
      env,
    ),
    decrypt(
      {
        ciphertext: account.session_ciphertext,
        nonce: account.session_nonce,
        keyVersion: account.session_key_version,
      },
      env,
    ),
  ])
  return { account, email, sessionId }
}

async function listAccounts(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    'SELECT * FROM accounts ORDER BY created_at ASC',
  ).all<AccountRow>()
  return json({ accounts: result.results.map(publicAccount) })
}

export async function markAccountReauthRequired(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE accounts SET status = 'reauth-required', updated_at = ? WHERE id = ?`,
  )
    .bind(new Date().toISOString(), accountId)
    .run()
}

export async function withAccountSession<T>(
  env: Env,
  accountId: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof HttpError && error.code === 'grooop-unauthorized') {
      console.warn('Grooop session rejected; marking account for reauthentication', { accountId })
      await markAccountReauthRequired(env, accountId)
    }
    throw error
  }
}

async function createChallengeForEmail(email: string, env: Env): Promise<Response> {
  const emailHash = await lookupHash(email, env)
  const now = new Date()

  await env.DB.prepare('DELETE FROM login_challenges WHERE expires_at <= ?')
    .bind(now.toISOString())
    .run()

  const encrypted = await encrypt(email, env)
  const id = crypto.randomUUID()
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString()
  const cooldownCutoff = new Date(now.getTime() - CHALLENGE_COOLDOWN_MS).toISOString()
  await env.DB.prepare('DELETE FROM login_challenges WHERE email_hash = ? AND created_at <= ?')
    .bind(emailHash, cooldownCutoff)
    .run()
  const claimed = await env.DB.prepare(
    `INSERT INTO login_challenges
      (id, email_ciphertext, email_nonce, email_key_version, email_hash, attempts, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(email_hash) DO NOTHING
     RETURNING id`,
  )
    .bind(
      id,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.keyVersion,
      emailHash,
      expiresAt,
      now.toISOString(),
    )
    .first<{ id: string }>()
  if (!claimed) {
    throw new HttpError(429, 'challenge-cooldown', 'Wait before requesting another code')
  }

  try {
    const result = await grooopRequest<{ status?: string }>('login/magic/create', {
      method: 'POST',
      body: { email },
    })
    if (extractStatus(result) !== 'success') {
      throw new HttpError(422, 'magic-code-rejected', 'Code request failed')
    }
  } catch (error) {
    await env.DB.prepare('DELETE FROM login_challenges WHERE id = ?').bind(id).run()
    throw error
  }

  return json({ challenge: { id, email: maskEmail(email) } }, { status: 201 })
}

async function createChallenge(request: Request, env: Env): Promise<Response> {
  assertSameOrigin(request)
  const body = requireObject(await readJson(request))
  return createChallengeForEmail(requireEmail(body.email), env)
}

async function reauthenticateAccount(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  assertSameOrigin(request)
  const account = await accountById(env, accountId)
  if (account.status !== 'reauth-required') {
    throw new HttpError(409, 'account-reauth-not-required', 'Account does not require re-authentication')
  }
  const email = await decrypt(
    {
      ciphertext: account.email_ciphertext,
      nonce: account.email_nonce,
      keyVersion: account.email_key_version,
    },
    env,
  )
  return createChallengeForEmail(email, env)
}

async function verifyChallenge(
  request: Request,
  env: Env,
  challengeId: string,
): Promise<Response> {
  assertSameOrigin(request)
  const body = requireObject(await readJson(request))
  const code = requireMagicCode(body.code)
  const now = new Date().toISOString()
  const challenge = await env.DB.prepare(
    `UPDATE login_challenges
     SET attempts = attempts + 1
     WHERE id = ? AND attempts < ? AND expires_at > ?
     RETURNING *`,
  )
    .bind(challengeId, MAX_CODE_ATTEMPTS, now)
    .first<ChallengeRow>()
  if (!challenge) {
    const rejected = await env.DB.prepare(
      'SELECT attempts, expires_at FROM login_challenges WHERE id = ?',
    )
      .bind(challengeId)
      .first<Pick<ChallengeRow, 'attempts' | 'expires_at'>>()
    if (!rejected) {
      throw new HttpError(404, 'challenge-not-found', 'Login challenge was not found')
    }
    if (rejected.expires_at <= now) {
      await env.DB.prepare('DELETE FROM login_challenges WHERE id = ? AND expires_at <= ?')
        .bind(challengeId, now)
        .run()
      throw new HttpError(410, 'challenge-expired', 'The login code has expired')
    }
    if (rejected.attempts >= MAX_CODE_ATTEMPTS) {
      throw new HttpError(429, 'too-many-code-attempts', 'Request a new login code')
    }
    console.error('Login challenge attempt claim failed without a terminal reason')
    throw new HttpError(409, 'challenge-attempt-conflict', 'Retry the login code')
  }

  const email = await decrypt(
    {
      ciphertext: challenge.email_ciphertext,
      nonce: challenge.email_nonce,
      keyVersion: challenge.email_key_version,
    },
    env,
  )
  const login = await grooopRequest<{
    status?: string
    sessionId?: unknown
  }>('login/magic/verify', {
    method: 'POST',
    body: { email, code },
  })
  const loginStatus = extractStatus(login)
  if (loginStatus !== 'success' || typeof login.sessionId !== 'string' || !login.sessionId) {
    throw new HttpError(422, loginStatus || 'invalid-code', 'Grooop did not accept the code')
  }

  const user = await retrieveUser(login.sessionId)
  const [existing, conflictingUser] = await Promise.all([
    env.DB.prepare(
      'SELECT id, created_at, grooop_user_id FROM accounts WHERE email_hash = ?',
    )
      .bind(challenge.email_hash)
      .first<{ id: string; created_at: string; grooop_user_id: number }>(),
    env.DB.prepare('SELECT id, email_hash FROM accounts WHERE grooop_user_id = ?')
      .bind(user.id)
      .first<{ id: string; email_hash: string }>(),
  ])
  if (existing && existing.grooop_user_id !== user.id) {
    console.error('Verified Grooop session changed the account identity')
    throw new HttpError(409, 'account-identity-changed', 'Account identity changed')
  }
  if (conflictingUser && conflictingUser.email_hash !== challenge.email_hash) {
    console.error('Grooop user ID is already bound to another account record')
    throw new HttpError(409, 'account-identity-conflict', 'Account identity conflicts with existing data')
  }
  const proposedAccountId = existing?.id ?? crypto.randomUUID()
  const verifiedAt = new Date().toISOString()
  const [encryptedEmail, encryptedSession] = await Promise.all([
    encrypt(email, env),
    encrypt(login.sessionId, env),
  ])
  const saved = await env.DB.prepare(
    `INSERT INTO accounts (
       id, email_ciphertext, email_nonce, email_key_version, email_hash, email_masked,
       session_ciphertext, session_nonce, session_key_version, grooop_user_id, grooopies,
       status, validated_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(email_hash) DO UPDATE SET
       email_ciphertext = excluded.email_ciphertext,
       email_nonce = excluded.email_nonce,
       email_key_version = excluded.email_key_version,
       email_masked = excluded.email_masked,
       session_ciphertext = excluded.session_ciphertext,
       session_nonce = excluded.session_nonce,
       session_key_version = excluded.session_key_version,
       grooopies = excluded.grooopies,
       status = 'active',
       validated_at = excluded.validated_at,
       updated_at = excluded.updated_at
     WHERE accounts.grooop_user_id = excluded.grooop_user_id
     RETURNING id`,
  )
    .bind(
      proposedAccountId,
      encryptedEmail.ciphertext,
      encryptedEmail.nonce,
      encryptedEmail.keyVersion,
      challenge.email_hash,
      maskEmail(email),
      encryptedSession.ciphertext,
      encryptedSession.nonce,
      encryptedSession.keyVersion,
      user.id,
      user.grooopies,
      verifiedAt,
      existing?.created_at ?? verifiedAt,
      verifiedAt,
    )
    .first<{ id: string }>()
  if (!saved) {
    console.error('Concurrent verification changed the account identity')
    throw new HttpError(409, 'account-identity-changed', 'Account identity changed')
  }
  await env.DB.prepare('DELETE FROM login_challenges WHERE id = ?').bind(challengeId).run()

  const account = await accountById(env, saved.id)
  return json({ account: publicAccount(account) })
}

async function refreshAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  assertSameOrigin(request)
  const { account, sessionId } = await accountSecrets(env, accountId)
  await withAccountSession(env, accountId, async () => {
    const user = await retrieveUser(sessionId)
    if (user.id !== account.grooop_user_id) {
      console.error('Refreshed Grooop session changed user identity')
      throw new HttpError(409, 'account-identity-changed', 'Account identity changed')
    }
    const now = new Date().toISOString()
    await env.DB.prepare(
      `UPDATE accounts
       SET grooopies = ?, status = 'active', validated_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(user.grooopies, now, now, accountId)
      .run()
  })
  return json({ account: publicAccount(await accountById(env, accountId)) })
}

async function deleteAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  assertSameOrigin(request)
  await accountById(env, accountId)
  const activeMatch = await env.DB.prepare(
    `SELECT id FROM matches
     WHERE (host_account_id = ? OR guest_account_id = ?)
       AND status NOT IN ('finished', 'error')
     LIMIT 1`,
  )
    .bind(accountId, accountId)
    .first<{ id: string }>()
  if (activeMatch) {
    throw new HttpError(409, 'account-in-active-match', 'Finish the active match before removal')
  }
  const historicalMatch = await env.DB.prepare(
    `SELECT id FROM matches
     WHERE host_account_id = ? OR guest_account_id = ?
     LIMIT 1`,
  )
    .bind(accountId, accountId)
    .first<{ id: string }>()
  if (historicalMatch) {
    throw new HttpError(409, 'account-has-history', 'Accounts with match history cannot be removed')
  }
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId).run()
  return new Response(null, { status: 204 })
}

export async function handleAccountsApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/accounts')) return null
  if (request.method === 'GET' && url.pathname === '/api/accounts') {
    return listAccounts(env)
  }
  if (request.method === 'POST' && url.pathname === '/api/accounts/challenges') {
    return createChallenge(request, env)
  }

  const verification = url.pathname.match(/^\/api\/accounts\/challenges\/([a-f0-9-]+)\/verify$/)
  if (request.method === 'POST' && verification) {
    return verifyChallenge(request, env, verification[1])
  }
  const refresh = url.pathname.match(/^\/api\/accounts\/([a-f0-9-]+)\/refresh$/)
  if (request.method === 'POST' && refresh) {
    return refreshAccount(request, env, refresh[1])
  }
  const reauthentication = url.pathname.match(
    /^\/api\/accounts\/([a-f0-9-]+)\/reauthenticate$/,
  )
  if (request.method === 'POST' && reauthentication) {
    return reauthenticateAccount(request, env, reauthentication[1])
  }
  const removal = url.pathname.match(/^\/api\/accounts\/([a-f0-9-]+)$/)
  if (request.method === 'DELETE' && removal) {
    return deleteAccount(request, env, removal[1])
  }
  return null
}
