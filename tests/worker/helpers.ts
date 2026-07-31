import { env } from 'cloudflare:test'
import { encrypt, lookupHash } from '../../worker/crypto'

export const ORIGIN = 'https://app.test'

export function jsonRequest(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  origin = ORIGIN,
): Request {
  const headers = new Headers({ Origin: origin })
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

interface AccountFixture {
  id: string
  email: string
  sessionId: string
  userId: number
  grooopies?: number
  status?: 'active' | 'reauth-required'
}

export async function seedAccount(fixture: AccountFixture): Promise<void> {
  const [email, session, emailHash] = await Promise.all([
    encrypt(fixture.email, env),
    encrypt(fixture.sessionId, env),
    lookupHash(fixture.email, env),
  ])
  const now = '2026-01-01T00:00:00.000Z'
  await env.DB.prepare(
    `INSERT INTO accounts (
       id, email_ciphertext, email_nonce, email_key_version, email_hash, email_masked,
       session_ciphertext, session_nonce, session_key_version, grooop_user_id, grooopies,
       status, validated_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    fixture.id,
    email.ciphertext,
    email.nonce,
    email.keyVersion,
    emailHash,
    `${fixture.email.slice(0, 2)}***@${fixture.email.split('@')[1]}`,
    session.ciphertext,
    session.nonce,
    session.keyVersion,
    fixture.userId,
    fixture.grooopies ?? 1_000,
    fixture.status ?? 'active',
    now,
    now,
    now,
  ).run()
}
