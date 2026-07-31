import { describe, expect, it } from 'vitest'
import { assertSameOrigin, requireEmail, requireMagicCode } from '../../worker/validation'

describe('request validation', () => {
  it('normalizes controlled account emails', () => {
    expect(requireEmail('  Mirsella1@GMAIL.com ')).toBe('mirsella1@gmail.com')
    expect(() => requireEmail('not-an-email')).toThrowError('Enter a valid email address')
  })

  it('requires exactly eight alphanumeric code characters', () => {
    expect(requireMagicCode('ab12cd34')).toBe('AB12CD34')
    expect(() => requireMagicCode('1234567')).toThrowError('Enter the 8-character code')
    expect(() => requireMagicCode('1234-678')).toThrowError('Enter the 8-character code')
  })

  it('allows mutations only from the same origin', () => {
    const valid = new Request('https://party.example/api/accounts', {
      headers: { Origin: 'https://party.example' },
    })
    expect(() => assertSameOrigin(valid)).not.toThrow()

    const invalid = new Request('https://party.example/api/accounts', {
      headers: { Origin: 'https://attacker.example' },
    })
    expect(() => assertSameOrigin(invalid)).toThrowError('Request origin is not allowed')
  })
})
