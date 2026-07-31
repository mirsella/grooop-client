import type { Env } from './env'
import { HttpError, json, readJson } from './http'
import { assertSameOrigin, requireObject } from './validation'

interface TeamPresetRow {
  id: string
  name: string
  roster_json: string
  created_at: string
  updated_at: string
}

interface ObservedQuestionRow {
  content_slug: string
  category: string | null
  question: string
  answer: string
  first_seen_at: string
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40) {
    throw new HttpError(400, `invalid-${field}`, `${field} must be 1 to 40 characters`)
  }
  return value.trim()
}

function teamPresetInput(value: unknown): { name: string; roster: string[] } {
  const body = requireObject(value)
  if (!Array.isArray(body.roster) || body.roster.length < 1 || body.roster.length > 12) {
    throw new HttpError(400, 'invalid-roster', 'A preset needs 1 to 12 players')
  }
  return {
    name: requiredString(body.name, 'name'),
    roster: body.roster.map((player) => requiredString(player, 'player')),
  }
}

function publicPreset(row: TeamPresetRow): Record<string, unknown> {
  let roster: unknown
  try {
    roster = JSON.parse(row.roster_json)
  } catch {
    console.error(`Team preset ${row.id} has invalid roster JSON`)
    throw new HttpError(500, 'invalid-team-preset', 'Stored team preset is invalid')
  }
  if (!Array.isArray(roster) || !roster.every((player) => typeof player === 'string')) {
    console.error(`Team preset ${row.id} has an invalid roster`)
    throw new HttpError(500, 'invalid-team-preset', 'Stored team preset is invalid')
  }
  return {
    id: row.id,
    name: row.name,
    roster,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function presetById(env: Env, id: string): Promise<TeamPresetRow> {
  const row = await env.DB.prepare('SELECT * FROM team_presets WHERE id = ?')
    .bind(id)
    .first<TeamPresetRow>()
  if (!row) throw new HttpError(404, 'team-preset-not-found', 'Team preset was not found')
  return row
}

async function listPresets(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    'SELECT * FROM team_presets ORDER BY updated_at DESC, created_at DESC',
  ).all<TeamPresetRow>()
  return json({ presets: result.results.map(publicPreset) })
}

async function createPreset(request: Request, env: Env): Promise<Response> {
  assertSameOrigin(request)
  const input = teamPresetInput(await readJson(request))
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO team_presets (id, name, roster_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, input.name, JSON.stringify(input.roster), now, now).run()
  return json({ preset: publicPreset(await presetById(env, id)) }, { status: 201 })
}

async function updatePreset(request: Request, env: Env, id: string): Promise<Response> {
  assertSameOrigin(request)
  await presetById(env, id)
  const input = teamPresetInput(await readJson(request))
  await env.DB.prepare(
    'UPDATE team_presets SET name = ?, roster_json = ?, updated_at = ? WHERE id = ?',
  ).bind(input.name, JSON.stringify(input.roster), new Date().toISOString(), id).run()
  return json({ preset: publicPreset(await presetById(env, id)) })
}

async function deletePreset(request: Request, env: Env, id: string): Promise<Response> {
  assertSameOrigin(request)
  await presetById(env, id)
  await env.DB.prepare('DELETE FROM team_presets WHERE id = ?').bind(id).run()
  return new Response(null, { status: 204 })
}

async function listQuestions(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT content_slug, category, question, answer, first_seen_at
     FROM observed_questions ORDER BY first_seen_at DESC`,
  ).all<ObservedQuestionRow>()
  return json({
    questions: result.results.map((row) => ({
      content: row.content_slug,
      category: row.category,
      question: row.question,
      answer: row.answer,
      firstSeenAt: row.first_seen_at,
    })),
  })
}

export async function handleLibraryApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/team-presets') {
    return listPresets(env)
  }
  if (request.method === 'POST' && url.pathname === '/api/team-presets') {
    return createPreset(request, env)
  }
  const preset = url.pathname.match(/^\/api\/team-presets\/([a-f0-9-]+)$/)
  if (request.method === 'PUT' && preset) return updatePreset(request, env, preset[1])
  if (request.method === 'DELETE' && preset) return deletePreset(request, env, preset[1])
  if (request.method === 'GET' && url.pathname === '/api/questions') {
    return listQuestions(env)
  }
  return null
}
