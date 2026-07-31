import { HttpError } from './http'

const API_BASE = 'https://server.grooop.io/api/1.0/'
const USER_AGENT = 'curl/8.21.0'

interface GrooopOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  sessionId?: string
}

export interface GrooopUser {
  id: number
  email?: string
  firstname?: string
  grooopies: number
  [key: string]: unknown
}

export async function grooopRequest<T>(
  path: string,
  options: GrooopOptions = {},
): Promise<T> {
  const headers = new Headers({
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  })
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  if (options.sessionId) {
    headers.set('bearer', options.sessionId)
    headers.set('Cookie', `grooop=${options.sessionId}`)
  }

  let response: Response
  try {
    response = await fetch(new URL(path, API_BASE), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new HttpError(502, 'grooop-unavailable', 'Grooop did not respond')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    console.warn('Grooop returned a non-JSON response', response.status)
    throw new HttpError(502, 'grooop-invalid-response', 'Grooop returned an invalid response')
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new HttpError(401, 'grooop-unauthorized', 'Grooop rejected this session')
    }
    throw new HttpError(502, 'grooop-request-failed', 'Grooop rejected the request')
  }

  return payload as T
}

export function extractStatus(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const status = (value as Record<string, unknown>).status
  return typeof status === 'string' ? status : ''
}

export function requireGrooopUser(value: unknown): GrooopUser {
  if (!value || typeof value !== 'object') {
    throw new HttpError(422, 'grooop-user-missing', 'Grooop did not return a usable user')
  }

  const user = value as Record<string, unknown>
  if (
    !Number.isInteger(user.id) ||
    Number(user.id) <= 0 ||
    !Number.isSafeInteger(user.grooopies) ||
    Number(user.grooopies) < 0
  ) {
    throw new HttpError(422, 'grooop-user-invalid', 'Grooop returned an invalid user')
  }

  return user as GrooopUser
}

export async function retrieveUser(sessionId: string): Promise<GrooopUser> {
  const payload = await grooopRequest<{ user?: unknown }>('user/retrieve', { sessionId })
  return requireGrooopUser(payload.user)
}
