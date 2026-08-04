import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
  plugins: [react()],
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
