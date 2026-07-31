import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type JsonObject, type SocketFrame, SharedState } from '../../worker/shared-state'

interface Record { sequence: number, role: 'host' | 'guest', direction: 'in' | 'out', frame: SocketFrame }
const fixture = JSON.parse(readFileSync(new URL('../fixtures/grooop/ttmc-production.json', import.meta.url), 'utf8')) as {
  configuredRounds: number, records: Record[]
}

describe('sanitized production TTMC fixture', () => {
  it('replays the app-0 rounds list and per-round score applications', () => {
    const state = new SharedState()
    for (const record of fixture.records) {
      if (record.role === 'host' && record.direction === 'in' && (record.frame.t === '@SO' || record.frame.t === '@SL')) {
        expect(state.apply(record.frame)).toBe(true)
      }
    }
    const rounds = state.list(0, 'rounds').map((round) => round as JsonObject)
    expect(rounds).toHaveLength(fixture.configuredRounds)
    expect(rounds[0]).toMatchObject({ gameName: 'ttmc-round', state: 'finished', played: [] })
    for (const round of rounds) {
      expect(Number.isSafeInteger(round.id)).toBe(true)
      expect(state.list(round.id as number, 'scores').every((score) => typeof (score as JsonObject).id === 'number')).toBe(true)
    }
    expect((state.get(0, 'party') as JsonObject).state).toBe('finished')
    expect(rounds.at(-1)?.state).not.toBe('playing')
  })

  it('contains independent starts, recovery requests, observed answer schemas, and no credentials', () => {
    const outbound = fixture.records.filter((record) => record.direction === 'out').map((record) => record.frame)
    expect(outbound.filter((frame) => frame.t === 'start')).toHaveLength(18)
    expect(outbound.some((frame) => frame.t === 'get-question')).toBe(true)
    expect(outbound.some((frame) => frame.t === 'start-round')).toBe(true)
    const answers = outbound.filter((frame) => frame.t === 'answer').map((frame) => frame.d)
    expect(answers.some((answer) => typeof answer === 'boolean')).toBe(true)
    expect(answers.some((answer) => Array.isArray(answer))).toBe(true)
    expect(answers.some((answer) => typeof answer === 'string')).toBe(true)
    const encoded = JSON.stringify(fixture)
    expect(encoded).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
    expect(encoded).not.toMatch(/bearer|session|password/i)
  })
})
