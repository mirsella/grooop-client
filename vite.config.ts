import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Keep Vite's default file-system deny list when adding project-specific secrets.
const defaultFsDeny = [
  '.env',
  '.env.*',
  '*.{crt,pem,key,p12,pfx,cer,der}',
  '.npmrc',
  '.yarnrc.yml',
  '**/.git/**',
]

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  server: {
    fs: {
      deny: [
        ...defaultFsDeny,
        '.creds/**',
        '**/.creds/**',
        '.wrangler/**',
        '**/.wrangler/**',
      ],
    },
  },
})
