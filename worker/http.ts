export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return Response.json(data, { ...init, headers })
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'invalid-content-type', 'Expected application/json')
  }

  try {
    return (await request.json()) as T
  } catch {
    throw new HttpError(400, 'invalid-json', 'Request body is not valid JSON')
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message }, { status: error.status })
  }

  console.error('Unhandled request error')
  return json(
    { error: 'internal-error', message: 'The request could not be completed' },
    { status: 500 },
  )
}
