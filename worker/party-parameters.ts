import { HttpError } from './http'

export interface TtmcContent {
  slug: string
  title: string
}

export interface TtmcParameters {
  owned: boolean
  rounds: readonly [number, number, number, number]
  contents: TtmcContent[]
}

export function parseParameterRange(value: unknown): readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isSafeInteger) ||
    value[0] > value[1] || value[2] < value[0] || value[2] > value[1] || value[3] <= 0 ||
    (value[2] - value[0]) % value[3] !== 0) {
    console.error('Grooop returned invalid party parameters')
    throw new HttpError(502, 'invalid-party-parameters', 'Grooop returned invalid party parameters')
  }
  return [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])]
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function parseTtmcParameters(value: unknown): TtmcParameters {
  const root = object(value)
  const parameters = object(root?.parameters)
  const ttmc = object(parameters?.ttmc)
  const rounds = parseParameterRange(ttmc?.rounds)
  const modes = root?.gameModes
  if (!Array.isArray(modes)) {
    console.error('Grooop returned invalid TTMC parameters')
    throw new HttpError(502, 'invalid-party-parameters', 'Grooop returned invalid party parameters')
  }

  const ttmcModes = modes.filter((mode) => object(mode)?.name === 'ttmc')
  const mode = ttmcModes.length === 1 ? object(ttmcModes[0]) : null
  if (!mode || typeof mode.isBought !== 'boolean') {
    console.error('Grooop returned invalid TTMC ownership')
    throw new HttpError(502, 'invalid-party-parameters', 'Grooop returned invalid party parameters')
  }

  const rawContents = ttmc?.contents
  if (!Array.isArray(rawContents)) {
    console.error('Grooop returned invalid TTMC content parameters')
    throw new HttpError(502, 'invalid-ttmc-contents', 'Grooop returned invalid TTMC content parameters')
  }
  const slugs = new Set<string>()
  const contents: TtmcContent[] = []
  for (const value of rawContents) {
    const content = object(value)
    const slug = content?.slug
    const title = content?.title
    if (!content || typeof slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(slug) ||
      typeof title !== 'string' || !title.trim() || title !== title.trim() || title.length > 120 ||
      typeof content.available !== 'boolean' || slugs.has(slug)) {
      console.error('Grooop returned invalid TTMC content parameters')
      throw new HttpError(502, 'invalid-ttmc-contents', 'Grooop returned invalid TTMC content parameters')
    }
    slugs.add(slug)
    if (content.available) contents.push({ slug, title })
  }
  if (contents.length > 32) {
    console.error('Grooop returned too many available TTMC content parameters')
    throw new HttpError(502, 'invalid-ttmc-contents', 'Grooop returned invalid TTMC content parameters')
  }

  return {
    owned: mode.isBought,
    rounds,
    contents,
  }
}
