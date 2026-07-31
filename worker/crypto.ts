import type { Env } from './env'
import { HttpError } from './http'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface EncryptedValue {
  ciphertext: string
  nonce: string
  keyVersion: string
}

export function encryptionIsConfigured(env: Env): boolean {
  if (!env.ENCRYPTION_KEY_VERSION?.trim()) return false
  try {
    return base64ToBytes(env.ENCRYPTION_KEY).byteLength === 32
  } catch {
    return false
  }
}

function keyVersion(env: Env): string {
  const version = env.ENCRYPTION_KEY_VERSION?.trim()
  if (!version) {
    console.error('Encryption key version is missing')
    throw new HttpError(500, 'encryption-misconfigured', 'Encrypted storage is unavailable')
  }
  return version
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = base64ToBytes(env.ENCRYPTION_KEY)
  } catch {
    console.error('Encryption key is not valid base64')
    throw new HttpError(500, 'encryption-misconfigured', 'Encrypted storage is unavailable')
  }

  if (raw.byteLength !== 32) {
    console.error('Encryption key must decode to exactly 32 bytes')
    throw new HttpError(500, 'encryption-misconfigured', 'Encrypted storage is unavailable')
  }

  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encrypt(value: string, env: Env): Promise<EncryptedValue> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    await encryptionKey(env),
    encoder.encode(value),
  )
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    nonce: bytesToBase64(nonce),
    keyVersion: keyVersion(env),
  }
}

export async function decrypt(value: EncryptedValue, env: Env): Promise<string> {
  if (value.keyVersion !== keyVersion(env)) {
    console.error('Encrypted value uses an unavailable key version')
    throw new HttpError(500, 'key-version-unavailable', 'Encrypted storage is unavailable')
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(value.nonce) },
      await encryptionKey(env),
      base64ToBytes(value.ciphertext),
    )
    return decoder.decode(plaintext)
  } catch {
    console.error('Encrypted value could not be decrypted')
    throw new HttpError(500, 'decryption-failed', 'Encrypted storage is unavailable')
  }
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return bytesToBase64(new Uint8Array(digest))
}

export async function lookupHash(value: string, env: Env): Promise<string> {
  const material = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(env.ENCRYPTION_KEY),
    'HKDF',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('grooop-party-pwa'),
      info: encoder.encode('email-lookup-v1'),
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return bytesToBase64(new Uint8Array(signature))
}

export function maskEmail(email: string): string {
  const [local, domain] = email.toLowerCase().split('@')
  if (!local || !domain) return '***'
  const visible = local.slice(0, Math.min(2, local.length))
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`
}
