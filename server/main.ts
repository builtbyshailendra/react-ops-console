// npm run build && npm start   (PORT, DB_PATH, STATIC_DIR to override)

import path from 'node:path'
import { startApp } from './app.ts'

const root = path.resolve(import.meta.dirname, '..')
const app = await startApp({
  port: Number(process.env.PORT ?? 8098),
  dbPath: process.env.DB_PATH ?? path.join(root, 'ops.db'),
  staticDir: process.env.STATIC_DIR ?? path.join(root, 'dist'),
})
console.log(`react-ops-console on ${app.url}  (demo tokens: demo-asha, demo-ravi, demo-viewer)`)
const stop = (): void => { void app.close().then(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
