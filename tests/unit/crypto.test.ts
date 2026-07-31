import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, encryptionIsConfigured, lookupHash, maskEmail, sha256 } from '../../worker/crypto'
import type { Env } from '../../worker/env'

const env = {
  ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ENCRYPTION_KEY_VERSION: 'v1',
} as Env

describe('encrypted storage', () => {
  it('requires a 32-byte key and a key version for production readiness', () => {
    expect(encryptionIsConfigured(env)).toBe(true)
    expect(encryptionIsConfigured({ ...env, ENCRYPTION_KEY: 'not-base64' })).toBe(false)
    expect(encryptionIsConfigured({ ...env, ENCRYPTION_KEY_VERSION: '' })).toBe(false)
    expect(encryptionIsConfigured({ ...env, ENCRYPTION_KEY_VERSION: '  ' })).toBe(false)
  })

  it('round trips values with unique nonces', async () => {
    const first = await encrypt('session-secret', env)
    const second = await encrypt('session-secret', env)

    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.nonce).not.toBe(second.nonce)
    await expect(decrypt(first, env)).resolves.toBe('session-secret')
    await expect(decrypt(second, env)).resolves.toBe('session-secret')
  })

  it('rejects an unavailable key version', async () => {
    const encrypted = await encrypt('session-secret', env)
    await expect(decrypt({ ...encrypted, keyVersion: 'retired' }, env)).rejects.toMatchObject({
      code: 'key-version-unavailable',
    })
  })
})

describe('account privacy helpers', () => {
  it('masks the local part while retaining a recognizable prefix', () => {
    expect(maskEmail('mirsella1@gmail.com')).toBe('mi*******@gmail.com')
    expect(maskEmail('a@example.com')).toBe('a***@example.com')
  })

  it('hashes normalized identifiers deterministically', async () => {
    await expect(sha256('same@example.com')).resolves.toBe(await sha256('same@example.com'))
    expect(await sha256('same@example.com')).not.toBe(await sha256('other@example.com'))
  })

  it('uses a secret-keyed hash for identifier lookup', async () => {
    const first = await lookupHash('same@example.com', env)
    expect(first).toBe(await lookupHash('same@example.com', env))
    expect(first).not.toBe(await sha256('same@example.com'))
    expect(first).not.toBe(await lookupHash('same@example.com', {
      ...env,
      ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    }))
  })
})
