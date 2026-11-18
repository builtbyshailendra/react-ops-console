import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `npm run dev`: Vite on 5173 with the API proxied to the Node server on 8098.
// `npm run build`: static files in dist/, which the Node server serves itself.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/ops.v1.IncidentService': 'http://127.0.0.1:8098' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
