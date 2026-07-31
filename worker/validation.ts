import { HttpError } from './http'

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid-body', 'Expected a JSON object')
  }
  return value as Record<string, unknown>
}

export function requireEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid-email', 'Email is required')
  }
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'invalid-email', 'Enter a valid email address')
  }
  return email
}

export function requireMagicCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]{8}$/i.test(value.trim())) {
    throw new HttpError(400, 'invalid-code-format', 'Enter the 8-character code')
  }
  return value.trim().toUpperCase()
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin')
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'invalid-origin', 'Request origin is not allowed')
  }
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'invalid-idempotency-key', 'A valid idempotency key is required')
  }
  return value.toLowerCase()
}
