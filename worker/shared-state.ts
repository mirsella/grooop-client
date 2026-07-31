export type JsonObject = Record<string, unknown>

export interface SocketFrame {
  a?: number | string | null
  t?: string
  d?: unknown
  u?: string
}

export class SharedState {
  private readonly entities = new Map<string, Map<string, unknown>>()

  apply(frame: SocketFrame): boolean {
    if (
      !frame || typeof frame !== 'object' || Array.isArray(frame) ||
      (frame.t !== '@SO' && frame.t !== '@SL') ||
      !frame.d || typeof frame.d !== 'object' || Array.isArray(frame.d) ||
      (typeof frame.a !== 'number' && typeof frame.a !== 'string')
    ) {
      console.warn('Skipping malformed shared-state frame')
      return false
    }
    const update = frame.d as JsonObject
    if (typeof update.a !== 'string' || typeof update.k !== 'string') {
      console.warn('Skipping shared-state update without operation or key')
      return false
    }

    const application = String(frame.a)
    const isList = frame.t === '@SL'
    const matchesFrame = (value: unknown) => isList
      ? Array.isArray(value)
      : Boolean(value && typeof value === 'object' && !Array.isArray(value))

    if (update.a === 'C') {
      if (!matchesFrame(update.v)) {
        console.warn('Skipping shared-state creation with the wrong entity type')
        return false
      }
      let applicationEntities = this.entities.get(application)
      if (!applicationEntities) {
        applicationEntities = new Map()
        this.entities.set(application, applicationEntities)
      }
      applicationEntities.set(update.k, update.v)
      return true
    }

    const applicationEntities = this.entities.get(application)
    if (!applicationEntities) {
      console.warn('Skipping update for a missing shared-state application')
      return false
    }
    const current = applicationEntities.get(update.k)
    if (update.a === 'D') {
      if (!matchesFrame(current)) {
        console.warn('Skipping shared-state deletion with the wrong entity type')
        return false
      }
      applicationEntities.delete(update.k)
      return true
    }
    if (!applicationEntities.has(update.k)) {
      console.warn('Skipping update for a missing shared-state entity')
      return false
    }

    if (!isList) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        console.warn('Skipping object update for a non-object entity')
        return false
      }
      const next = { ...(current as JsonObject) }
      if (update.a === 'M' && typeof update.n === 'string') next[update.n] = update.v
      else if (update.a === 'R' && typeof update.n === 'string') delete next[update.n]
      else {
        console.warn('Skipping unsupported shared-object operation')
        return false
      }
      applicationEntities.set(update.k, next)
      return true
    }

    if (!Array.isArray(current)) {
      console.warn('Skipping list update for a non-list entity')
      return false
    }
    const next = [...current]
    const index = update.n
    const validIndex = Number.isInteger(index) && Number(index) >= 0 && Number(index) < next.length
    if (update.a === 'A') next.push(update.v)
    else if (update.a === 'R' && validIndex) next.splice(Number(index), 1)
    else if (update.a === 'M' && validIndex) next[Number(index)] = update.v
    else if (
      update.a === 'P' &&
      validIndex &&
      typeof update.p === 'string' &&
      next[Number(index)] &&
      typeof next[Number(index)] === 'object' &&
      !Array.isArray(next[Number(index)])
    ) next[Number(index)] = { ...(next[Number(index)] as JsonObject), [update.p]: update.v }
    else {
      console.warn('Skipping unsupported shared-list operation')
      return false
    }
    applicationEntities.set(update.k, next)
    return true
  }

  get(application: number | string, key: string): unknown {
    return this.entities.get(String(application))?.get(key)
  }

  list(application: number | string, key: string): unknown[] {
    const applicationEntities = this.entities.get(String(application))
    const value = applicationEntities?.get(key)
    if (!applicationEntities || !Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (item && typeof item === 'object' && typeof (item as JsonObject).__ === 'string') {
        const referenced = applicationEntities.get((item as JsonObject).__ as string)
        return referenced === undefined ? [] : [referenced]
      }
      return [item]
    })
  }
}
