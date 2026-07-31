import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PartySocket } from '../../worker/match-room'

type FakeEvent = { data?: unknown, code?: number }
type FakeListener = { callback: (event: FakeEvent) => void, once: boolean }

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  private readonly listeners = new Map<string, FakeListener[]>()

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  addEventListener(
    type: string,
    callback: (event: FakeEvent) => void,
    options?: boolean | { once?: boolean },
  ): void {
    const once = typeof options === 'object' && options.once === true
    const listeners = this.listeners.get(type) ?? []
    listeners.push({ callback, once })
    this.listeners.set(type, listeners)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  accept(): void {
    this.open()
  }

  open(): void {
    if (this.readyState === FakeWebSocket.OPEN) return
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
  }

  message(data: string): void {
    this.emit('message', { data })
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code: 1005 })
  }

  private emit(type: string, event: FakeEvent = {}): void {
    const listeners = [...(this.listeners.get(type) ?? [])]
    this.listeners.set(type, listeners.filter((listener) => !listener.once))
    for (const listener of listeners) listener.callback(event)
  }
}

function latestTransport(): FakeWebSocket {
  const transport = FakeWebSocket.instances.at(-1)
  if (!transport) throw new Error('Expected PartySocket to create a WebSocket')
  return transport
}

function sentFrame(transport: FakeWebSocket, index = transport.sent.length - 1): Record<string, unknown> {
  return JSON.parse(transport.sent[index]) as Record<string, unknown>
}

async function connect(socket: PartySocket): Promise<FakeWebSocket> {
  const connecting = socket.connect()
  await Promise.resolve()
  const transport = latestTransport()
  transport.open()
  await Promise.resolve()
  const synchronization = sentFrame(transport)
  transport.message(JSON.stringify({
    a: synchronization.a,
    t: synchronization.t,
    d: '@OK',
    u: synchronization.u,
  }))
  await connecting
  return transport
}

describe('PartySocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const transport = new FakeWebSocket(input instanceof Request ? input.url : input)
      return { status: 101, webSocket: transport } as Response
    }))
    let sequence = 0
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => (
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`
    ))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('synchronizes with @SE/@OK without logging the session-bearing URL', async () => {
    const logSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    const changed = vi.fn()
    const socket = new PartySocket('party / code', async () => 'session secret', changed)

    const transport = await connect(socket)

    expect(transport.url).toBe('https://server.grooop.io/ws/party/party%20%2F%20code?bearer=session%20secret')
    expect(sentFrame(transport, 0)).toEqual({
      a: null,
      t: '@SE',
      d: null,
      u: '00000000-0000-4000-8000-000000000001',
    })
    expect(socket.connected).toBe(true)
    expect(changed).toHaveBeenCalledOnce()

    const logged = logSpies.flatMap((spy) => spy.mock.calls.flat()).map(String).join(' ')
    expect(logged).not.toContain('session secret')
    expect(logged).not.toContain(transport.url)
    expect(transport.sent.join(' ')).not.toContain('session secret')
  })

  it('echoes @P frames unchanged', async () => {
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const transport = await connect(socket)

    transport.message('@P-heartbeat-token')

    expect(transport.sent.at(-1)).toBe('@P-heartbeat-token')
  })

  it('surfaces a sanitized Grooop connection rejection', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const connecting = socket.connect()
    await Promise.resolve()
    const transport = latestTransport()
    transport.open()
    await Promise.resolve()

    transport.message('@CE lobby-not-found')

    await expect(connecting).rejects.toMatchObject({
      status: 502,
      code: 'party-socket-rejected',
      message: 'Grooop rejected the party connection',
    })
    expect(warning).toHaveBeenCalledWith(
      'Grooop rejected a party socket connection',
      { reason: 'lobby-not-found' },
    )
  })

  it('closes and logs when a heartbeat echo cannot be sent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const transport = await connect(socket)
    vi.spyOn(transport, 'send').mockImplementation(() => { throw new Error('send failed') })

    transport.message('@P-heartbeat-token')

    expect(transport.readyState).toBe(FakeWebSocket.CLOSED)
    expect(error).toHaveBeenCalledWith('Party socket failed to echo a heartbeat')
  })

  it('applies shared-state frames received before the correlated synchronization response', async () => {
    const changed = vi.fn()
    const socket = new PartySocket('party', async () => 'session', changed)
    const connecting = socket.connect()
    await Promise.resolve()
    const transport = latestTransport()
    transport.open()
    await Promise.resolve()
    const synchronization = sentFrame(transport)

    transport.message(JSON.stringify({
      a: 0,
      t: '@SO',
      d: { a: 'C', k: 'party', v: { state: 'running' } },
    }))

    expect(socket.shared.get(0, 'party')).toEqual({ state: 'running' })
    expect(socket.connected).toBe(false)
    expect(changed).toHaveBeenCalledOnce()

    transport.message(JSON.stringify({ a: null, t: '@SE', d: '@OK', u: synchronization.u }))
    await connecting
    expect(socket.connected).toBe(true)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('correlates responses by the generated request UUID', async () => {
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const transport = await connect(socket)
    const response = socket.request(7, 'answer', 3)
    let settled = false
    void response.then(() => { settled = true })
    const request = sentFrame(transport)

    expect(request).toEqual({
      a: 7,
      t: 'answer',
      d: 3,
      u: '00000000-0000-4000-8000-000000000002',
    })

    transport.message(JSON.stringify({ t: '@RE', d: 'wrong response', u: 'unrelated-uuid' }))
    await Promise.resolve()
    expect(settled).toBe(false)

    transport.message(JSON.stringify({ a: 7, t: 'answer', d: 'accepted', u: request.u }))
    await expect(response).resolves.toBe('accepted')
  })

  it('closes instead of resolving a correlated non-response frame', async () => {
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const transport = await connect(socket)
    const pending = socket.request(7, 'answer', 3)
    const request = sentFrame(transport)

    transport.message(JSON.stringify({ t: '@SO', d: {}, u: request.u }))

    await expect(pending).rejects.toThrow('Party socket closed')
    expect(transport.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('allows only one in-flight request', async () => {
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const transport = await connect(socket)
    const first = socket.request(7, 'answer', 1)

    expect(() => socket.request(7, 'answer', 2)).toThrow('Party socket already has an in-flight request')

    const request = sentFrame(transport)
    transport.message(JSON.stringify({ a: 7, t: 'answer', d: 'accepted', u: request.u }))
    await expect(first).resolves.toBe('accepted')
  })

  it('rejects a pending request when the transport closes', async () => {
    const changed = vi.fn()
    const socket = new PartySocket('party', async () => 'session', changed)
    const transport = await connect(socket)
    const pending = socket.request(7, 'answer', 1)
    const rejection = expect(pending).rejects.toThrow('Party socket closed')

    transport.close()

    await rejection
    expect(socket.connected).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('loads the current session again for every reconnect', async () => {
    let session = 'first-session'
    const loadSession = vi.fn(async () => session)
    const socket = new PartySocket('party', loadSession, vi.fn())
    const first = await connect(socket)
    expect(first.url).toContain('bearer=first-session')

    first.close()
    session = 'second-session'
    const second = await connect(socket)

    expect(second.url).toContain('bearer=second-session')
    expect(loadSession).toHaveBeenCalledTimes(2)
  })

  it('times out a pending request and closes the transport', async () => {
    vi.useFakeTimers()
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const transport = await connect(socket)
    const pending = socket.request(7, 'answer', 1)
    const rejection = expect(pending).rejects.toThrow('Party request answer timed out')

    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect(transport.readyState).toBe(FakeWebSocket.CLOSED)
    expect(socket.connected).toBe(false)
  })

  it.each(['null', '[]', '1', '{}', '{'])('closes on malformed JSON protocol frame %s', async (frame) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const transport = await connect(socket)

    transport.message(frame)

    expect(transport.readyState).toBe(FakeWebSocket.CLOSED)
    expect(socket.connected).toBe(false)
    expect(error).toHaveBeenCalled()
  })

  it('closes when a shared-state update is rejected', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const transport = await connect(socket)

    transport.message(JSON.stringify({
      a: 7,
      t: '@SL',
      d: { a: 'M', k: 'missing', n: 0, v: { id: 101 } },
    }))

    expect(transport.readyState).toBe(FakeWebSocket.CLOSED)
    expect(socket.connected).toBe(false)
    expect(error).toHaveBeenCalledWith('Party socket returned a rejected shared-state update')
  })
})
