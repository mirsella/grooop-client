import type { LiveMatch } from '../api'
import { isLiveMatch, isRecord, type MatchCommand } from './domain'

type SocketState = 'idle' | 'connecting' | 'open' | 'retrying'
type ActionResult = string | string[] | null
type InFlightAction = { id: string; command: MatchCommand }

const resultText = (result: ActionResult) => result === null
  ? 'Action accepted.'
  : typeof result === 'string' ? `Action accepted: ${result}.` : `Action accepted: ${result.join(', ')}.`

export class LiveMatchConnection {
  match = $state<LiveMatch | null>(null)
  state = $state<SocketState>('idle')
  error = $state('')
  result = $state('')
  inFlight = $state<InFlightAction | null>(null)
  retryAvailable = $state(false)
  matchId = $state<string | null>(null)
  private socket: WebSocket | null = null
  private stopped = true
  private retries = 0
  private reconnectTimer: number | undefined
  private heartbeat: number | undefined

  constructor(
    private readonly onActionError: (command: MatchCommand) => void,
    private readonly onState: (match: LiveMatch) => void,
  ) {}

  open(matchId: string | null) {
    if (this.matchId === matchId && !this.stopped) return
    this.close()
    this.matchId = matchId
    this.match = null
    this.result = ''
    this.error = ''
    this.inFlight = null
    this.retryAvailable = false
    if (!matchId) {
      this.state = 'idle'
      return
    }
    this.stopped = false
    this.retries = 0
    this.connect()
  }

  private connect = () => {
    if (this.stopped || !this.matchId) return
    this.retryAvailable = false
    this.state = this.retries ? 'retrying' : 'connecting'
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/api/matches/${encodeURIComponent(this.matchId)}/socket`)
    this.socket = socket
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return
      this.state = 'open'
      this.error = ''
      this.heartbeat = window.setInterval(() => {
        if (this.socket === socket && socket.readyState === WebSocket.OPEN) socket.send('ping')
      }, 20_000)
    }
    socket.onmessage = (event) => this.receive(socket, event.data)
    socket.onerror = () => {
      if (!this.stopped && this.socket === socket) socket.close()
    }
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return
      if (this.heartbeat !== undefined) window.clearInterval(this.heartbeat)
      this.socket = null
      this.inFlight = null
      this.result = ''
      if (this.retries >= 6) {
        this.state = 'idle'
        this.error = 'The live match could not reconnect after six attempts.'
        this.retryAvailable = true
        return
      }
      this.state = 'retrying'
      const delay = Math.min(1_000 * 2 ** this.retries, 10_000)
      this.retries += 1
      this.reconnectTimer = window.setTimeout(this.connect, delay)
    }
  }

  private breakConnection(socket: WebSocket, message: string) {
    this.match = null
    this.inFlight = null
    this.result = ''
    this.error = message
    socket.onmessage = null
    socket.close()
  }

  private receive(socket: WebSocket, data: unknown) {
    if (this.socket !== socket) return
    if (typeof data !== 'string') return this.breakConnection(socket, 'The live match sent a binary frame; reconnecting.')
    let message: unknown
    try { message = JSON.parse(data) } catch { return this.breakConnection(socket, 'The live match sent malformed JSON; reconnecting.') }
    if (!isRecord(message) || typeof message.type !== 'string') return this.breakConnection(socket, 'The live match sent an invalid message; reconnecting.')
    if (message.type === 'state') {
      if (!isLiveMatch(message.match)) return this.breakConnection(socket, 'The live match state did not match the expected shape; reconnecting.')
      this.retries = 0
      this.match = message.match
      this.onState(message.match)
      this.error = ''
      return
    }
    if (message.type === 'action-result') {
      const valid = message.result === null || typeof message.result === 'string' ||
        (Array.isArray(message.result) && message.result.every((item) => typeof item === 'string'))
      if (!valid || typeof message.actionId !== 'string' || message.actionId !== this.inFlight?.id) {
        return this.breakConnection(socket, 'The match returned an invalid action result; reconnecting.')
      }
      this.error = ''
      this.result = resultText(message.result as ActionResult)
      this.inFlight = null
      return
    }
    if (message.type === 'action-error') {
      if (typeof message.actionId !== 'string' || message.actionId !== this.inFlight?.id) {
        return this.breakConnection(socket, 'The match returned an invalid action error; reconnecting.')
      }
      this.result = ''
      this.error = typeof message.message === 'string' ? message.message :
        typeof message.error === 'string' ? message.error : 'The match action was rejected.'
      this.onActionError(this.inFlight.command)
      this.inFlight = null
      return
    }
    if (message.type === 'connection') {
      if (message.connected !== false) return this.breakConnection(socket, 'The match sent an invalid connection update.')
      if (this.match) this.match = { ...this.match, connected: false }
      this.error = 'The upstream party connection was interrupted.'
      return
    }
    if (message.type === 'pong') return
    if (message.type === 'error') {
      this.error = typeof message.error === 'string' ? message.error : 'The live match reported an error.'
      return
    }
    this.breakConnection(socket, `The live match sent an unsupported “${message.type}” message; reconnecting.`)
  }

  send(command: MatchCommand): string | null {
    const socket = this.socket
    if (this.state !== 'open' || !socket || socket.readyState !== WebSocket.OPEN) {
      this.error = 'Wait for the live connection before sending an action.'
      return null
    }
    if (!this.match?.connected) {
      this.error = 'Wait for the upstream party connection before sending an action.'
      return null
    }
    if (this.inFlight) {
      this.error = 'Wait for the current action to finish.'
      return null
    }
    const actionId = crypto.randomUUID()
    this.inFlight = { id: actionId, command }
    this.error = ''
    this.result = 'Sending...'
    try { socket.send(JSON.stringify({ ...command, actionId })) } catch { socket.close(); return null }
    return actionId
  }

  retry = () => {
    this.retryAvailable = false
    this.error = ''
    this.stopped = false
    this.retries = 0
    this.connect()
  }

  fail(message: string) { this.error = message }

  close() {
    this.stopped = true
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    if (this.heartbeat !== undefined) window.clearInterval(this.heartbeat)
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
  }
}
