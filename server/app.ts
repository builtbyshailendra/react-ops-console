// One HTTP server for both the API (ConnectRPC: the Connect protocol and
// gRPC-Web over HTTP/1.1) and the built React app.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { connectNodeAdapter } from '@connectrpc/connect-node'
import { routes } from './service.ts'
import { Store } from './store.ts'

export interface App {
  url: string
  port: number
  store: Store
  close(): Promise<void>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
}

export async function startApp(opts: { port?: number; dbPath?: string; staticDir?: string; seed?: boolean } = {}): Promise<App> {
  const store = new Store(opts.dbPath)
  if (opts.seed !== false) store.seed()
  const handler = connectNodeAdapter({
    routes: routes(store),
    // Anything that isn't an RPC is a file of the React app. The server is
    // HTTP/1.1 (http.createServer), so these are always IncomingMessage/ServerResponse.
    fallback: (req, res) => serveStatic(opts.staticDir, req as http.IncomingMessage, res as http.ServerResponse),
  })
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    store,
    close: () => new Promise((resolve) => {
      server.closeAllConnections() // end open timeline streams
      server.close(() => { store.close(); resolve() })
    }),
  }
}

function serveStatic(dir: string | undefined, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!dir || req.method !== 'GET') { res.writeHead(404).end(); return }
  const root = path.resolve(dir)
  const url = new URL(req.url ?? '/', 'http://x')
  let file = path.resolve(root, '.' + path.posix.normalize('/' + decodeURIComponent(url.pathname)))
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html') // single-page app
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body)
  })
}
