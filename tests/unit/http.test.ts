import { describe, expect, it, vi } from 'vitest'
import { errorResponse, json } from '../../worker/http'

describe('HTTP response security', () => {
  it('marks JSON responses as private and non-sniffable', () => {
    const response = json({ status: 'ok' })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('does not log or return unexpected error details', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = errorResponse(new Error('session-secret-value'))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('session-secret-value')
    expect(logged.mock.calls.flat().join(' ')).not.toContain('session-secret-value')
    logged.mockRestore()
  })
})
