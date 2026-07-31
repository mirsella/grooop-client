import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeEach } from 'vitest'

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shop_purchases'),
    env.DB.prepare('DELETE FROM observed_questions'),
    env.DB.prepare('DELETE FROM matches'),
    env.DB.prepare('DELETE FROM login_challenges'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM team_presets'),
  ])
})
