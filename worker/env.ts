export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  MATCHES: DurableObjectNamespace
  ENVIRONMENT: 'development' | 'test' | 'production'
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  OWNER_EMAIL: string
  ENCRYPTION_KEY: string
  ENCRYPTION_KEY_VERSION: string
}

export interface AccessIdentity {
  email: string
  subject: string
}
